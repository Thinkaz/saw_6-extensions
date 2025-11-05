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

const baseUrl = "https://roliascan.com";

type RoliascanImplementation = SettingsFormProviding &
    Extension &
    DiscoverSectionProviding &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    CloudflareBypassRequestProviding;

export class RoliascanExtension implements RoliascanImplementation {
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

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            {
                id: "popular",
                title: "Popular Lately",
                subtitle: "Most viewed series",
                type: DiscoverSectionType.featured,
            },
            {
                id: "latest",
                title: "Latest Updates",
                subtitle: "Recently updated manga",
                type: DiscoverSectionType.chapterUpdates,
            },
            {
                id: "weekly",
                title: "Weekly Recommendations",
                subtitle: "Staff picks of the week",
                type: DiscoverSectionType.simpleCarousel,
            },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: number | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = metadata ?? 1;
        const items: DiscoverSectionItem[] = [];

        const itemType: "prominentCarouselItem" | "simpleCarouselItem" =
            section.type === DiscoverSectionType.prominentCarousel
                ? "prominentCarouselItem"
                : "simpleCarouselItem";

        if (section.id === "weekly") {
            const request: Request = {
                url: baseUrl,
                method: "GET",
            };
            const $ = await this.fetchCheerio(request);

            $(
                ".carousel.home-novels-sld .col-6.col-sm-4.col-xl-2.p-3.post",
            ).each((_i, el) => {
                const $el = $(el);

                const titleElement = $el.find("h6 a");
                const link = titleElement.attr("href");
                const title = titleElement.text().trim();

                if (!link || !link.includes("/manga/")) return;

                const mangaId =
                    link.split("/manga/")[1]?.replace(/\/$/, "") ?? "";
                const imageUrl = this.fixImageUrl(
                    $el.find("img.poster").attr("src") ?? "",
                );

                if (mangaId && title) {
                    items.push({
                        mangaId,
                        title,
                        imageUrl,
                        type: itemType,
                    });
                }
            });

            return {
                items,
                metadata: undefined,
            };
        } else if (section.id === "latest") {
            const request: Request = {
                url: `${baseUrl}/updated-mangas0/?_paged=${page}`,
                method: "GET",
            };
            const $ = await this.fetchCheerio(request);

            $(".article-feed .post").each((_i, el) => {
                const $el = $(el);

                const titleElement = $el.find("h6.titleh6series a");
                const link = titleElement.attr("href");
                const title = titleElement.text().trim();

                if (!link || !link.includes("/manga/")) return;

                const mangaId =
                    link.split("/manga/")[1]?.replace(/\/$/, "") ?? "";
                const imageUrl = this.fixImageUrl(
                    $el.find("img").attr("src") ?? "",
                );

                const firstChapterLink = $el
                    .find(".chapter-row")
                    .first()
                    .find("a")
                    .attr("href");

                const latestChapterTitle = $el
                    .find(".chapter-row")
                    .first()
                    .find("a")
                    .text()
                    .trim();

                let chapterId = "";
                if (firstChapterLink) {
                    const chapterMatch =
                        firstChapterLink.match(/\/chapter-([^/?]+)/);
                    chapterId = chapterMatch?.[1] ?? "";
                }

                if (mangaId && title && chapterId) {
                    items.push({
                        mangaId,
                        title,
                        chapterId,
                        subtitle: latestChapterTitle || undefined,
                        imageUrl,
                        type: "chapterUpdatesCarouselItem",
                    });
                }
            });

            console.log(
                `[Roliascan] Page ${page}: Found ${items.length} items`,
            );

            const pagerHtml = $(".facetwp-pager").html();
            console.log(
                `[Roliascan] Pager HTML: ${pagerHtml ? pagerHtml.substring(0, 200) : "NOT FOUND"}`,
            );

            const allPagerLinks = $(".facetwp-pager a");
            console.log(
                `[Roliascan] Found ${allPagerLinks.length} pager links`,
            );

            const nextPageAttr = $(".facetwp-pager .facetwp-page.next").attr(
                "data-page",
            );
            const lastPageAttr = $(".facetwp-pager .facetwp-page.last").attr(
                "data-page",
            );

            console.log(
                `[Roliascan] Next page attr: ${nextPageAttr}, Last page attr: ${lastPageAttr}`,
            );

            let nextMetadata: number | undefined = undefined;

            if (items.length > 0 && page < 10) {
                nextMetadata = page + 1;
                console.log(
                    `[Roliascan] Forcing next page to: ${nextMetadata}`,
                );
            }

            return {
                items,
                metadata: nextMetadata,
            };
        } else {
            // Logique pour "Popular Lately" (via JSON)
            const request: Request = {
                url: `${baseUrl}/wp-content/themes/animacewp/most_viewed_series.json`,
                method: "GET",
            };

            const [response, data] = await Application.scheduleRequest(request);
            await this.checkCloudflareStatus(response.status);
            const jsonStr = Application.arrayBufferToUTF8String(data);

            let jsonData:
                | {
                      most_viewed_series: {
                          url: string;
                          title: string;
                          image: string;
                      }[];
                  }
                | undefined;
            try {
                jsonData = JSON.parse(jsonStr) as typeof jsonData;
            } catch {
                console.error("[Roliascan] Failed to parse popular JSON");
                throw new Error("Failed to parse popular items JSON.");
            }

            if (!jsonData || !jsonData.most_viewed_series) {
                console.error(
                    "[Roliascan] Popular JSON is in an unexpected format.",
                );
                return { items: [] };
            }

            for (const manga of jsonData.most_viewed_series) {
                const mangaUrl = manga.url;
                const title = manga.title;
                const imageUrl = this.fixImageUrl(manga.image);

                if (!mangaUrl || !mangaUrl.includes("/manga/") || !title) {
                    continue;
                }

                const mangaId =
                    mangaUrl.split("/manga/")[1]?.replace(/\/$/, "") ?? "";

                if (mangaId && title) {
                    items.push({
                        mangaId,
                        title,
                        imageUrl,
                        type: itemType,
                    });
                }
            }

            return {
                items,
                metadata: undefined,
            };
        }
    }

    async getSearchFilters(): Promise<SearchFilter[]> {
        return [];
    }

    async getSearchResults(
        query: SearchQuery,
    ): Promise<PagedResults<SearchResultItem>> {
        if (!query.title || query.title.trim() === "") {
            return { items: [] };
        }

        const searchQuery = encodeURIComponent(query.title.trim());
        const request = {
            url: `${baseUrl}/?s=${searchQuery}&asp_active=1&p_asid=1&p_asp_data=1&asp_gen[]=title&asp_gen[]=exact`,
            method: "GET" as const,
        };

        const $ = await this.fetchCheerio(request);
        const results: SearchResultItem[] = [];

        $(".col-12.p-3.post").each((_i, el) => {
            const $el = $(el);
            const link = $el.find("a").first().attr("href");

            if (!link || !link.includes("/manga/")) return;

            const mangaId = link.split("/manga/")[1]?.replace(/\/$/, "") ?? "";
            const title = $el.find("h4 a").text().trim();
            const imageUrl = this.fixImageUrl(
                $el.find("img.poster").attr("src") ?? "",
            );

            const badge = $el.find(".custom-badge").text().trim();

            if (mangaId && title) {
                results.push({
                    mangaId,
                    title,
                    subtitle: badge || undefined,
                    imageUrl,
                });
            }
        });

        return {
            items: results,
        };
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request: Request = {
            url: `${baseUrl}/manga/${mangaId}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);

        const title =
            $(".post-type-header-inner h1").first().text().trim() || mangaId;

        const rawImageUrl =
            $("img.poster, .col-md-3 img.wp-post-image").first().attr("src") ??
            "";
        const imageUrl = this.fixImageUrl(rawImageUrl);
        const validImageUrl =
            imageUrl && imageUrl.startsWith("http") ? imageUrl : "";

        let author = "Unknown";
        $("table.table tr").each((_i, el) => {
            const $row = $(el);
            const header = $row.find("th").text().trim().toLowerCase();
            if (header.includes("artist")) {
                author = $row.find("td").text().trim();
            }
        });

        let description = "No description available.";
        $(".card-movies-series .card-body").each((_i, el) => {
            const $el = $(el);
            const h5Text = $el.find("h5").first().text().trim().toLowerCase();
            if (h5Text.includes("synopsis")) {
                const allText: string[] = [];
                $el.find("p").each((_i, p) => {
                    const text = $(p).text().trim();
                    if (text.length > 0) {
                        allText.push(text);
                    }
                });
                if (allText.length > 0) {
                    description = allText.join(" ");
                }
            }
        });

        let status: "ONGOING" | "COMPLETED" | "UNKNOWN" = "UNKNOWN";
        $("table.table tr").each((_i, el) => {
            const $row = $(el);
            const header = $row.find("th").text().trim().toLowerCase();
            if (header.includes("status")) {
                const statusText = $row.find("td").text().trim().toLowerCase();
                if (statusText.includes("ongoing")) {
                    status = "ONGOING";
                } else if (
                    statusText.includes("completed") ||
                    statusText.includes("complete")
                ) {
                    status = "COMPLETED";
                }
            }
        });

        const tags: Tag[] = [];
        $(".post-type-header-inner .btn-custom").each((_i, el) => {
            const genreText = $(el).text().trim();
            if (genreText && genreText.length < 30) {
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

        console.log(`[Roliascan] Manga details loaded: ${title} by ${author}`);

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: validImageUrl,
                synopsis: description,
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
            url: `${baseUrl}/manga/${sourceManga.mangaId}/chapterlist/`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const chapters: Chapter[] = [];

        $(".chapter-list-row").each((i, el) => {
            const $el = $(el);
            const chapterLink = $el.find("a").first().attr("href");

            if (!chapterLink) return;

            const chapterMatch = chapterLink.match(/\/chapter-([^/?]+)/);
            const chapterId = chapterMatch?.[1] ?? `${i}`;

            const chapterTitle = $el.find(".main-chapter-title").text().trim();

            const chapNumMatch = chapterId.match(/^(\d+(?:\.\d+)?)/);
            const chapNum = chapNumMatch?.[1]
                ? parseFloat(chapNumMatch[1])
                : i + 1;

            const dateText = $el.find(".chapter-date").text().trim();
            const publishDate = this.parseRelativeDate(dateText);

            chapters.push({
                chapterId,
                sourceManga,
                langCode: "EN",
                chapNum,
                title: chapterTitle,
                volume: undefined,
                publishDate,
            });
        });

        return chapters.reverse();
    }

    private parseRelativeDate(dateText: string): Date {
        const now = new Date();
        const lowerText = dateText.toLowerCase();

        if (lowerText.includes("just now") || lowerText.includes("now")) {
            return now;
        }

        const minutesMatch = lowerText.match(/(\d+)\s*min/);
        if (minutesMatch && minutesMatch[1]) {
            const minutes = parseInt(minutesMatch[1]);
            return new Date(now.getTime() - minutes * 60 * 1000);
        }

        const hoursMatch = lowerText.match(/(\d+)\s*hour/);
        if (hoursMatch && hoursMatch[1]) {
            const hours = parseInt(hoursMatch[1]);
            return new Date(now.getTime() - hours * 60 * 60 * 1000);
        }

        const daysMatch = lowerText.match(/(\d+)\s*day/);
        if (daysMatch && daysMatch[1]) {
            const days = parseInt(daysMatch[1]);
            return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        }

        const monthNames = [
            "jan",
            "feb",
            "mar",
            "apr",
            "may",
            "jun",
            "jul",
            "aug",
            "sep",
            "oct",
            "nov",
            "dec",
        ];
        const dateMatch = lowerText.match(/(\w+)\s+(\d+),\s+(\d+)/);
        if (dateMatch && dateMatch[1] && dateMatch[2] && dateMatch[3]) {
            const monthStr = dateMatch[1];
            const day = parseInt(dateMatch[2]);
            const year = parseInt(dateMatch[3]);
            const month = monthNames.findIndex((m) => monthStr.startsWith(m));
            if (month !== -1) {
                return new Date(year, month, day);
            }
        }

        return now;
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const chapterUrl = `${baseUrl}/manga/${chapter.sourceManga.mangaId}/chapter-${chapter.chapterId}`;

        const request: Request = {
            url: chapterUrl,
            method: "GET",
        };

        const [response, data] = await Application.scheduleRequest(request);
        await this.checkCloudflareStatus(response.status);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const $ = cheerio.load(htmlStr);

        const pages: string[] = [];

        const contentContainer = $(".manga-child-the-content.my-5");
        if (contentContainer.length === 0) {
            throw new Error("Content container not found. Unable to extract images.");
        }

        contentContainer.find("img").each((index, el) => {
            const $img = $(el);

            let imgUrl = $img.attr("src") ?? $img.attr("data-src") ?? "";

            if (!imgUrl || imgUrl.trim() === "") {
                return;
            }

            imgUrl = imgUrl.trim();

            if (
                imgUrl.includes("roliascan.com/wp-content/uploads/2024/07/warning-1.png") ||
                imgUrl.includes("roliascan.com/wp-content/uploads/2025/09/end-chapter.jpg")
            ) {
                console.log(`[Roliascan] Skipped unwanted image: ${imgUrl.substring(0, 50)}...`);
                return;
            }

            const finalUrl = this.fixImageUrl(imgUrl);

            if (
                finalUrl &&
                finalUrl.trim() !== "" &&
                (finalUrl.startsWith("http://") || finalUrl.startsWith("https://"))
            ) {
                pages.push(finalUrl);
                console.log(
                    `[Roliascan] Added page ${pages.length}: ${finalUrl.substring(0, 50)}...`,
                );
            }
        });

        console.log(
            `[Roliascan] Chapter ${chapter.chapterId} - Found ${pages.length} pages`,
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

export const Roliascan = new RoliascanExtension();
