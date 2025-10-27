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

        const hasNextPage =
            $(".pagination-out").length > 0 &&
            $(".pagination-list li.pagination-next").length > 0;

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

        // Sélecteur pour les résultats de recherche
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

        // Vérifier s'il y a une page suivante
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

        const title = $(".story-info-right h1").text().trim() || mangaId;
        const rawImageUrl = $(".info-image img").attr("src") ?? "";
        const imageUrl = this.fixImageUrl(rawImageUrl);

        // Validation : si l'URL est vide ou invalide, utiliser une image par défaut
        const validImageUrl =
            imageUrl && imageUrl.startsWith("http")
                ? imageUrl
                : `${baseUrl}/images/default_nato.webp`;

        const description = $(".panel-story-info-description").text().trim();

        const tags: Tag[] = [];
        $(".variations-tableInfo .table-value a.a-h").each((_i, el) => {
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

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: validImageUrl,
                synopsis: description || "No synopsis available.",
                contentRating: ContentRating.EVERYONE,
                status: "UNKNOWN",
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

        $(".row-content-chapter li").each((i, el) => {
            const $el = $(el);
            const chapterLink = $el.find("a").attr("href");

            if (!chapterLink) return;

            const chapterId = chapterLink.split("/chapter-")[1] ?? `${i}`;
            const chapterTitle = $el.find("a").text().trim();

            const chapterMatch = chapterTitle.match(
                /chapter\s+(\d+(?:\.\d+)?)/i,
            );
            const chapNum =
                chapterMatch && chapterMatch[1]
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

        const cookie: Cookie = {
            name: "image_server",
            value: imageServer,
            domain: new URL(cookieDomain).hostname,
            path: "/",
            created: new Date(),
            expires: new Date(Date.now() + 86400000),
        };

        this.cookieStorageInterceptor.setCookie(cookie);

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
        const scriptContent = $("head").html() ?? "";
        const scriptMatch = scriptContent.match(/var cdns = \[(.*?)\];/s);

        if (scriptMatch && scriptMatch[1]) {
            try {
                const cdnString = `[${scriptMatch[1].replace(/'/g, '"')}]`;
                const parsed = JSON.parse(cdnString) as unknown;
                if (
                    Array.isArray(parsed) &&
                    parsed.every((p) => typeof p === "string")
                ) {
                    cdns = parsed;
                }
            } catch (e) {
                console.error("Failed to parse CDN list:", e);
            }
        }

        $(".container-chapter-reader img").each((_i, el) => {
            let imgUrl = $(el).attr("src") ?? $(el).attr("data-src");
            if (!imgUrl) return;

            if (
                cdns.length > 0 &&
                imageServerIndex >= 0 &&
                imageServerIndex < cdns.length
            ) {
                const targetCdn = cdns[imageServerIndex];
                if (targetCdn) {
                    for (const cdnUrl of cdns) {
                        imgUrl = imgUrl.replace(cdnUrl, targetCdn);
                    }
                }
            }

            pages.push(this.fixImageUrl(imgUrl));
        });

        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            pages,
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
        if (!url) return "";

        if (url.startsWith("//")) {
            return "https:" + url;
        }

        if (url.startsWith("/")) {
            return baseUrl + url;
        }

        return url;
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
