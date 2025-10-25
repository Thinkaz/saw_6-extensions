import {
    BasicRateLimiter,
    ContentRating,
    DiscoverSectionType,
    Form,
    type Chapter,
    type ChapterDetails,
    type ChapterProviding,
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

type NatoMetadata = {
    page?: number;
    collectedIds?: string[];
};

type NatomangaImplementation = SettingsFormProviding &
    Extension &
    DiscoverSectionProviding &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding;

export class NatomangaExtension implements NatomangaImplementation {
    mainRateLimiter = new BasicRateLimiter("main", {
        numberOfRequests: 15,
        bufferInterval: 10,
        ignoreImages: true,
    });

    mainInterceptor = new MainInterceptor("main");

    async initialise(): Promise<void> {
        this.mainRateLimiter.registerInterceptor();
        this.mainInterceptor.registerInterceptor();
    }

    async getSettingsForm(): Promise<Form> {
        return new SettingsForm();
    }

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            {
                id: "popular-manga",
                title: "Popular Manga",
                subtitle: "Most popular manga on the site",
                type: DiscoverSectionType.prominentCarousel,
            },
            {
                id: "latest-releases",
                title: "Latest Manga Releases",
                subtitle: "Recently updated manga",
                type: DiscoverSectionType.chapterUpdates,
            },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: NatoMetadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        switch (section.id) {
            case "popular-manga":
                return this.scrapePopularManga();
            case "latest-releases":
                return this.scrapeLatestReleases(metadata);
            default:
                return { items: [] };
        }
    }

    private async scrapePopularManga(): Promise<
        PagedResults<DiscoverSectionItem>
    > {
        const request: Request = { url: baseUrl, method: "GET" };
        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        $(".slide .owl-item .item").each((_i, el) => {
            const $el = $(el);

            const link = $el.find("a").attr("href");
            if (!link || link.includes("toffee.ai")) return;

            const title = $el.find(".slide-caption h3 a").text().trim();
            const imageUrl = $el.find("img").attr("src") ?? "";
            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";

            const chapterLink = $el.find('.slide-caption a[href*="/chapter"]');
            const supertitle = chapterLink.text().trim();

            if (mangaId && title) {
                items.push({
                    mangaId,
                    title,
                    supertitle: supertitle || undefined,
                    imageUrl,
                    type: "featuredCarouselItem",
                    metadata: undefined,
                });
            }
        });

        return { items, metadata: undefined };
    }

    private async scrapeLatestReleases(
        metadata: NatoMetadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = metadata?.page ?? 1;
        const collectedIds = metadata?.collectedIds ?? [];

        const request: Request = {
            url: `${baseUrl}/manga-list/latest-manga?page=${page}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        $(".doreamon .itemupdate.first").each((_i, el) => {
            const $el = $(el);

            const link = $el.find("a.cover").attr("href");
            if (!link || link.includes("toffee.ai")) return;

            const title = $el.find("h3 a").first().text().trim();
            const imageUrl =
                $el.find("img").attr("src") ??
                $el.find("img").attr("data-src") ??
                "";
            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";

            const latestChapterEl = $el.find("li").first().find("a");
            const subtitle = latestChapterEl.text().trim();
            const chapterHref = latestChapterEl.attr("href") ?? "";
            const chapterId = chapterHref.split("/chapter-")[1] ?? "0";

            if (mangaId && title && !collectedIds.includes(mangaId)) {
                collectedIds.push(mangaId);
                items.push({
                    mangaId,
                    title,
                    subtitle: subtitle || undefined,
                    imageUrl,
                    type: "chapterUpdatesCarouselItem",
                    chapterId,
                    metadata: undefined,
                });
            }
        });

        const hasNextPage = !!$(".pagination .current").next("a").length;

        return {
            items,
            metadata: hasNextPage
                ? { page: page + 1, collectedIds }
                : undefined,
        };
    }

    async getSearchFilters(): Promise<SearchFilter[]> {
        return [
            {
                id: "status",
                type: "dropdown",
                options: [
                    { id: "all", value: "All" },
                    { id: "ongoing", value: "Ongoing" },
                    { id: "completed", value: "Completed" },
                ],
                value: "all",
                title: "Status",
            },
        ];
    }

    async getSearchResults(
        query: SearchQuery,
        metadata?: NatoMetadata,
    ): Promise<PagedResults<SearchResultItem>> {
        const page = metadata?.page ?? 1;

        // URL format: https://www.natomanga.com/search/story/solo_leveling?page=2
        const searchQuery = query.title.trim().replace(/\s+/g, "_");
        const request: Request = {
            url: `${baseUrl}/search/story/${searchQuery}?page=${page}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const items: SearchResultItem[] = [];

        $(".doreamon .itemupdate.first").each((_i, el) => {
            const $el = $(el);

            const link = $el.find("a.cover").attr("href");
            if (!link || link.includes("toffee.ai")) return;

            const title = $el.find("h3 a").first().text().trim();
            const imageUrl =
                $el.find("img").attr("src") ??
                $el.find("img").attr("data-src") ??
                "";
            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";

            const latestChapter = $el
                .find("li")
                .first()
                .find("a")
                .text()
                .trim();

            if (mangaId && title) {
                items.push({
                    mangaId,
                    title,
                    subtitle: latestChapter || undefined,
                    imageUrl,
                });
            }
        });

        const hasNextPage = !!$(".pagination .current").next("a").length;

        return {
            items,
            metadata: hasNextPage ? { page: page + 1 } : undefined,
        };
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const url = `${baseUrl}/manga/${mangaId}`;
        const request: Request = { url, method: "GET" };
        const $ = await this.fetchCheerio(request);

        const title = $(".story-info-right h1").text().trim() || mangaId;
        const imageUrl = $(".info-image img").attr("src") ?? "";
        const description = $(".panel-story-info-description").text().trim();

        const altTitles: string[] = [];
        const tags: Tag[] = [];
        let status: "ONGOING" | "COMPLETED" | "UNKNOWN" = "UNKNOWN";
        let author = "";
        let rating = 0;

        $(".variations-tableInfo .table-label").each((_i, el) => {
            const label = $(el).text().trim().toLowerCase();
            const valueEl = $(el).next(".table-value");

            if (label.includes("alternative")) {
                const alts = valueEl.text().trim().split(";");
                altTitles.push(...alts.map((a) => a.trim()).filter((a) => a));
            } else if (label.includes("author")) {
                author = valueEl.text().trim();
            } else if (label.includes("status")) {
                const statusText = valueEl.text().trim().toLowerCase();
                if (statusText.includes("ongoing")) {
                    status = "ONGOING";
                } else if (statusText.includes("completed")) {
                    status = "COMPLETED";
                }
            } else if (label.includes("genre")) {
                valueEl.find("a").each((_j, genreEl) => {
                    const genreText = $(genreEl).text().trim();
                    if (genreText) {
                        tags.push({
                            id: genreText.toLowerCase().replace(/\s+/g, "-"),
                            title: genreText,
                        });
                    }
                });
            }
        });

        // Extract rating
        const ratingText = $(".rate-view .rating").text().trim();
        if (ratingText) {
            rating = parseFloat(ratingText);
        }

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
                secondaryTitles: altTitles,
                thumbnailUrl: imageUrl,
                synopsis: description,
                contentRating: ContentRating.EVERYONE,
                status,
                author,
                rating,
                tagGroups: tagSections,
            },
        };
    }

    async getChapters(
        sourceManga: SourceManga,
        sinceDate?: Date,
    ): Promise<Chapter[]> {
        const url = `${baseUrl}/manga/${sourceManga.mangaId}`;
        const request: Request = { url, method: "GET" };
        const $ = await this.fetchCheerio(request);

        const chapters: Chapter[] = [];

        $(".row-content-chapter li").each((i, el) => {
            const $el = $(el);
            const chapterLink = $el.find("a").attr("href");

            if (!chapterLink) return;

            const chapterId = chapterLink.split("/chapter-")[1] ?? `${i}`;
            const chapterTitle = $el.find("a").text().trim();

            // Extract chapter number from title
            const chapterMatch = chapterTitle.match(
                /chapter\s+(\d+(?:\.\d+)?)/i,
            );
            const chapNum =
                chapterMatch && chapterMatch[1]
                    ? parseFloat(chapterMatch[1])
                    : i + 1;

            // Extract date
            const dateText = $el.find(".chapter-time").text().trim();
            let publishDate: Date | undefined;
            if (dateText) {
                publishDate = this.parseDate(dateText);
            }

            chapters.push({
                chapterId,
                sourceManga,
                langCode: "EN",
                chapNum,
                title: chapterTitle,
                publishDate,
                volume: undefined,
            });
        });

        // If sinceDate is provided, filter out chapters published on or before that date.
        let result = chapters;
        if (sinceDate) {
            result = chapters.filter((ch) => {
                return ch.publishDate ? ch.publishDate > sinceDate : false;
            });
        }

        return result.sort((a, b) => b.chapNum - a.chapNum);
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        // URL format: https://www.natomanga.com/manga/regressor-instruction-manual/chapter-159
        const url = `${baseUrl}/manga/${chapter.sourceManga.mangaId}/chapter-${chapter.chapterId}`;
        const request: Request = { url, method: "GET" };
        const $ = await this.fetchCheerio(request);

        const pages: string[] = [];

        // Images are directly in .container-chapter-reader
        $(".container-chapter-reader img").each((_i, el) => {
            const imgUrl = $(el).attr("src") ?? $(el).attr("data-src");
            if (imgUrl) {
                pages.push(imgUrl);
            }
        });

        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            pages,
        };
    }

    getMangaShareUrl(mangaId: string): string {
        return `${baseUrl}/manga/${mangaId}`;
    }

    private parseDate(dateText: string): Date {
        const now = new Date();

        if (!dateText?.trim()) return now;

        // Handle relative dates like "1 hour ago", "2 days ago"
        const relativeMatch = dateText.match(
            /(\d+)\s+(second|minute|hour|day|week|month)s?\s+ago/i,
        );
        if (relativeMatch) {
            const value = parseInt(relativeMatch[1] ?? "0");
            const unit = (relativeMatch[2] ?? "").toLowerCase();

            switch (unit) {
                case "second":
                    now.setSeconds(now.getSeconds() - value);
                    break;
                case "minute":
                    now.setMinutes(now.getMinutes() - value);
                    break;
                case "hour":
                    now.setHours(now.getHours() - value);
                    break;
                case "day":
                    now.setDate(now.getDate() - value);
                    break;
                case "week":
                    now.setDate(now.getDate() - value * 7);
                    break;
                case "month":
                    now.setMonth(now.getMonth() - value);
                    break;
            }
            return now;
        }

        // Try parsing as regular date
        const parsedDate = new Date(dateText);
        return isNaN(parsedDate.getTime()) ? now : parsedDate;
    }

    private async fetchCheerio(request: Request): Promise<CheerioAPI> {
        const [, data] = await Application.scheduleRequest(request);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }
}

export const Natomanga = new NatomangaExtension();
