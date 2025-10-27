import {
    BasicRateLimiter,
    CloudflareError,
    ContentRating,
    CookieStorageInterceptor,
    DiscoverSectionType,
    Form,
    type Chapter,
    type ChapterDetails,
    type ChapterProviding,
    type CloudflareBypassRequestProviding,
    type Cookie,
    type DiscoverSection,
    type DiscoverSectionItem,
    type DiscoverSectionProviding,
    type Extension,
    type MangaProviding,
    type PagedResults,
    type Request,
    type SearchFilter,
    type SearchQuery,
    type SearchResultItem,
    type SearchResultsProviding,
    type SettingsFormProviding,
    type SourceManga,
    type Tag,
    type TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import * as htmlparser2 from "htmlparser2";
import { SettingsForm } from "./forms";
import { MainInterceptor } from "./network";

const baseUrl = "https://www.natomanga.com";

type NatomangaImplementation = SettingsFormProviding &
    Extension &
    DiscoverSectionProviding &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    CloudflareBypassRequestProviding;

export class NatomangaExtension implements NatomangaImplementation {
    mainRateLimiter = new BasicRateLimiter("main", {
        numberOfRequests: 4,
        bufferInterval: 1,
        ignoreImages: true,
    });

    mainInterceptor = new MainInterceptor("main");

    cookieStorageInterceptor = new CookieStorageInterceptor({
        storage: "stateManager",
    });

    async initialise(): Promise<void> {
        this.mainRateLimiter.registerInterceptor();
        this.mainInterceptor.registerInterceptor();
        this.cookieStorageInterceptor.registerInterceptor();
    }

    async getSettingsForm(): Promise<Form> {
        return new SettingsForm();
    }

    private async getImageServerIndex(): Promise<number> {
        const server = (await Application.getState("image_server")) as
            | string[]
            | undefined;
        return parseInt(server?.[0]?.replace("server", "") ?? "1") - 1;
    }

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            {
                id: "4",
                title: "Latest Updates",
                subtitle: "The most recently updated chapters",
                type: DiscoverSectionType.prominentCarousel,
            },
            {
                id: "1",
                title: "New Titles",
                subtitle: "Recently added manga to the source",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "7",
                title: "Most Popular",
                subtitle: "Titles with the most views",
                type: DiscoverSectionType.simpleCarousel,
            },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: number | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = metadata ?? 1;

        const request: Request = {
            url: `${baseUrl}/genre/all?filter=${section.id}&page=${page}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        const itemType: "prominentCarouselItem" | "simpleCarouselItem" =
            section.type === DiscoverSectionType.prominentCarousel
                ? "prominentCarouselItem"
                : "simpleCarouselItem";

        $("div.comic-list div.list-comic-item-wrap").each((_i, el) => {
            const $el = $(el);

            const link = $el.find("a.list-story-item").attr("href");
            if (!link) return;

            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";
            const title = $el.find("h3 a").first().text().trim();

            const rawImageUrl =
                $el.find("img").attr("src") ??
                $el.find("img").attr("data-src") ??
                "";
            const imageUrl = this.fixImageUrl(rawImageUrl);

            const subtitle = $el
                .find("a.list-story-item-wrap-chapter")
                .text()
                .trim();

            if (mangaId && title) {
                items.push({
                    mangaId,
                    title,
                    subtitle: subtitle || undefined,
                    imageUrl,
                    type: itemType,
                });
            }
        });

        let hasNextPage = false;

        const currentPageText = $(".group_page a.page_select").text().trim();
        const currentPageNum = parseInt(currentPageText) || page;

        const lastPageLink = $(".group_page a.page_last").text();
        const lastPageMatch = lastPageLink.match(/Last\((\d+)\)/);

        if (lastPageMatch) {
            const lastPage = parseInt(lastPageMatch[1] ?? "1");
            hasNextPage = currentPageNum < lastPage;
        } else {
            const nextPageExists =
                $(`.group_page a[href*="page=${page + 1}"]`).length > 0;
            hasNextPage = nextPageExists && items.length > 0;
        }

        if (items.length === 0) {
            hasNextPage = false;
        }

        return {
            items,
            metadata: hasNextPage ? page + 1 : undefined,
        };
    }

    async getSearchFilters(): Promise<SearchFilter[]> {
        return [];
    }

    async getSearchResults(
        query: SearchQuery,
        metadata?: number,
    ): Promise<PagedResults<SearchResultItem>> {
        const page = metadata ?? 1;

        if (!query.title || query.title.trim() === "") {
            return { items: [] };
        }

        const searchQuery = query.title.trim().replace(/\s+/g, "_");
        const request = {
            url: `${baseUrl}/search/story/${searchQuery}?page=${page}`,
            method: "GET" as const,
        };

        const $ = await this.fetchCheerio(request);
        const results: SearchResultItem[] = [];

        $(".panel_story_list .story_item").each((_i, el) => {
            const $el = $(el);
            const link = $el.find("a").first().attr("href");
            if (!link) return;

            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";
            const title = $el.find("h3.story_name a").text().trim();

            const rawImageUrl =
                $el.find("img").attr("src") ??
                $el.find("img").attr("data-src") ??
                "";
            const imageUrl = this.fixImageUrl(rawImageUrl);

            const subtitle = $el
                .find("em.story_chapter a")
                .first()
                .text()
                .trim();

            if (mangaId && title) {
                results.push({
                    mangaId,
                    title,
                    subtitle: subtitle || undefined,
                    imageUrl,
                });
            }
        });

        const hasNextPage =
            $(".panel_page_number .group_page a.page_last").length > 0;

        return {
            items: results,
            metadata: hasNextPage ? page + 1 : undefined,
        };
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request: Request = {
            url: `${baseUrl}/manga/${mangaId}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);

        const title =
            $(".manga-info-text h1, .manga-info-top h1")
                .first()
                .text()
                .trim() ||
            $("h1").first().text().trim() ||
            mangaId;

        const rawImageUrl =
            $(".manga-info-pic img, .manga-info-top img").first().attr("src") ??
            "";
        const imageUrl = this.fixImageUrl(rawImageUrl);
        const validImageUrl =
            imageUrl && imageUrl.startsWith("http")
                ? imageUrl
                : `${baseUrl}/images/default_nato.webp`;

        let author = "Unknown";
        $(".manga-info-text li").each((_i, el) => {
            const text = $(el).text();
            if (text.includes("Author(s)")) {
                author = text
                    .replace("Author(s) :", "")
                    .replace("Author(s):", "")
                    .trim();
            }
        });

        const description = $("#contentBox").text().trim() || "";

        let status: "ONGOING" | "COMPLETED" | "UNKNOWN" = "UNKNOWN";
        $(".manga-info-text li").each((_i, el) => {
            const text = $(el).text().trim();
            if (text.includes("Status")) {
                if (text.toLowerCase().includes("ongoing")) {
                    status = "ONGOING";
                } else if (text.toLowerCase().includes("completed")) {
                    status = "COMPLETED";
                }
            }
        });

        const tags: Tag[] = [];
        $(".manga-info-text li.genres a").each((_i, el) => {
            const genreText = $(el).text().trim();
            if (genreText) {
                tags.push({
                    id: genreText.toLowerCase().replace(/\s+/g, "-"),
                    title: genreText,
                });
            }
        });

        const tagSections: TagSection[] = [];
        if (tags.length > 0) {
            tagSections.push({
                id: "genres",
                title: "Genres",
                tags,
            });
        }

        console.log(`[Natomanga] Manga details loaded: ${title} by ${author}`);

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: validImageUrl,
                synopsis: description || "No description available.",
                author: author !== "Unknown" ? author : undefined,
                contentRating: ContentRating.EVERYONE,
                status,
                tagGroups: tagSections,
            },
        };
    }

    async getChapters(
        sourceManga: SourceManga,
        sinceDate?: Date,
    ): Promise<Chapter[]> {
        void sinceDate;

        const request: Request = {
            url: `${baseUrl}/manga/${sourceManga.mangaId}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const chapters: Chapter[] = [];

        $(".chapter-list .row, .row-content-chapter li").each((i, el) => {
            const $el = $(el);
            const chapterLink = $el.find("a").first().attr("href");

            if (!chapterLink) return;

            const chapterIdMatch = chapterLink.match(/\/chapter-([^/?]+)/);
            const chapterId = chapterIdMatch?.[1] ?? `${i}`;

            const chapterTitle = $el.find("a").first().text().trim();

            const chapterMatch = chapterId.match(/^(\d+(?:\.\d+)?)/);
            const chapNum = chapterMatch?.[1]
                ? parseFloat(chapterMatch[1])
                : i + 1;

            chapters.push({
                chapterId,
                sourceManga,
                langCode: "EN",
                chapNum,
                title: chapterTitle,
                volume: undefined,
            });
        });

        return chapters;
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const imageServerIndex = await this.getImageServerIndex();
        const imageServer = imageServerIndex === 0 ? "server1" : "server2";

        const chapterUrl = `${baseUrl}/manga/${chapter.sourceManga.mangaId}/chapter-${chapter.chapterId}`;

        const cookieDomainMatch = chapterUrl.match(/(https?:\/\/[^/]+)/);
        const cookieDomain = cookieDomainMatch ? cookieDomainMatch[0] : baseUrl;

        this.cookieStorageInterceptor.setCookie({
            name: "content_server",
            value: imageServer,
            domain: cookieDomain,
            path: "/",
            created: new Date(),
            expires: new Date(Date.now() + 86400000),
        });

        const request: Request = {
            url: chapterUrl,
            method: "GET",
        };

        const [response, data] = await Application.scheduleRequest(request);
        await this.checkCloudflareStatus(response.status);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const $ = cheerio.load(htmlStr);

        const pages: string[] = [];

        let cdns: string[] = [];
        $("script").each((_i, scriptElement) => {
            const scriptContent = $(scriptElement).html() || "";

            const cdnsMatch = scriptContent.match(
                /var\s+cdns\s*=\s*\[(.*?)\];/s,
            );
            if (cdnsMatch && cdnsMatch[1]) {
                try {
                    const cdnString = `[${cdnsMatch[1].replace(/'/g, '"')}]`;
                    const parsed = JSON.parse(cdnString) as unknown;
                    if (
                        Array.isArray(parsed) &&
                        parsed.every((p) => typeof p === "string")
                    ) {
                        cdns = parsed;
                        console.log(
                            `[Natomanga] Found ${cdns.length} CDNs for chapter ${chapter.chapterId}`,
                        );
                    }
                } catch (e) {
                    console.error("[Natomanga] Failed to parse CDN list:", e);
                }
            }
        });

        $(".container-chapter-reader img").each((index, el) => {
            const $img = $(el);

            if ($img.closest(".ads-contain").length > 0) {
                console.log(`[Natomanga] Skipped ad image at index ${index}`);
                return;
            }

            let imgUrl = $img.attr("src") ?? $img.attr("data-src") ?? "";

            if (!imgUrl || imgUrl.trim() === "") {
                console.warn(`[Natomanga] Empty image URL at index ${index}`);
                return;
            }

            imgUrl = imgUrl.trim();

            if (
                cdns.length > 0 &&
                imageServerIndex >= 0 &&
                imageServerIndex < cdns.length
            ) {
                const targetCdn = cdns[imageServerIndex];
                if (targetCdn) {
                    for (const cdnUrl of cdns) {
                        if (imgUrl.includes(cdnUrl)) {
                            imgUrl = imgUrl.replace(cdnUrl, targetCdn);
                            break;
                        }
                    }
                }
            }

            const finalUrl = this.fixImageUrl(imgUrl);

            if (
                finalUrl &&
                finalUrl.trim() !== "" &&
                (finalUrl.startsWith("http://") ||
                    finalUrl.startsWith("https://"))
            ) {
                pages.push(finalUrl);
                console.log(
                    `[Natomanga] Added page ${pages.length}: ${finalUrl.substring(0, 50)}...`,
                );
            } else {
                console.warn(
                    `[Natomanga] Invalid URL skipped at index ${index}: "${finalUrl}"`,
                );
            }
        });

        console.log(
            `[Natomanga] Chapter ${chapter.chapterId} - Found ${pages.length} pages`,
        );

        if (pages.length === 0) {
            throw new Error(
                `No images found for chapter ${chapter.chapterId}. Check console logs for details.`,
            );
        }

        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            pages: pages,
        };
    }

    async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
        const existingCookies = [...this.cookieStorageInterceptor.cookies];
        for (const cookie of existingCookies) {
            this.cookieStorageInterceptor.deleteCookie(cookie);
        }

        for (const cookie of cookies) {
            if (!cookie.expires || cookie.expires.getTime() > Date.now()) {
                this.cookieStorageInterceptor.setCookie(cookie);
            }
        }

        console.log(
            "Cloudflare cookies saved:",
            this.cookieStorageInterceptor.cookies,
        );
    }

    async getCloudflareBypassRequest(): Promise<Request> {
        return {
            url: baseUrl,
            method: "GET",
            headers: {
                referer: baseUrl,
                origin: baseUrl,
            },
        };
    }

    async checkCloudflareStatus(status: number): Promise<void> {
        console.log("Response status:", status);
        console.log("Current cookies:", this.cookieStorageInterceptor.cookies);

        switch (status) {
            case 503:
            case 403:
                console.log(
                    `Cloudflare protection detected. Status: ${status}`,
                );
                throw new CloudflareError(
                    {
                        url: baseUrl,
                        method: "GET",
                        headers: {
                            referer: baseUrl,
                            origin: baseUrl,
                        },
                    },
                    "Cloudflare bypass required, please complete the challenge.",
                );
            case 404:
                throw new Error("Content not found");
        }
    }

    getMangaShareUrl(mangaId: string): string {
        return `${baseUrl}/manga/${mangaId}`;
    }

    private fixImageUrl(url: string): string {
        if (!url || url.trim() === "") return "";
        const trimmedUrl = url.trim();
        if (trimmedUrl.startsWith("//")) {
            return "https:" + trimmedUrl;
        }
        if (trimmedUrl.startsWith("/")) {
            return baseUrl + trimmedUrl;
        }
        return trimmedUrl;
    }

    private async fetchCheerio(request: Request): Promise<CheerioAPI> {
        const [response, data] = await Application.scheduleRequest(request);
        await this.checkCloudflareStatus(response.status);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }
}

export const Natomanga = new NatomangaExtension();
