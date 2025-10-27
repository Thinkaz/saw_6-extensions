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
        numberOfRequests: 15,
        bufferInterval: 10,
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

        // NOUVEAU : Bypass proactif au démarrage
        await this.ensureCloudflareBypass();
    }

    // NOUVELLE MÉTHODE : Vérifier et déclencher le bypass si nécessaire
    private async ensureCloudflareBypass(): Promise<void> {
        try {
            // Faire une requête test vers une page manga
            const testRequest: Request = {
                url: `${baseUrl}/manga/one-piece`,
                method: "GET",
            };

            const [response] = await Application.scheduleRequest(testRequest);

            // Si Cloudflare détecté, le signaler immédiatement
            if (response.status === 403 || response.status === 503) {
                throw new CloudflareError({
                    url: testRequest.url,
                    method: testRequest.method,
                });
            }
        } catch (error) {
            // Si c'est une CloudflareError, la laisser remonter
            if (error instanceof CloudflareError) {
                throw error;
            }
            // Autres erreurs : continuer silencieusement
            console.log("Cloudflare check skipped:", error);
        }
    }

    async getSettingsForm(): Promise<Form> {
        return new SettingsForm();
    }

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            {
                id: "popular-manga",
                title: "Popular Manga",
                subtitle: "Most popular manga",
                type: DiscoverSectionType.featured,
            },
            {
                id: "latest-updates",
                title: "Latest Updates",
                subtitle: "Recently updated manga",
                type: DiscoverSectionType.prominentCarousel,
            },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: number | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        void metadata;

        if (section.id === "popular-manga") {
            return this.getPopularManga();
        } else if (section.id === "latest-updates") {
            return this.getLatestUpdates();
        }

        return { items: [] };
    }

    private async getPopularManga(): Promise<
        PagedResults<DiscoverSectionItem>
    > {
        const request: Request = {
            url: baseUrl,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        // Carousel populaire : .slide .owl-carousel .item
        $(".slide .owl-carousel .item").each((_i, el) => {
            const $el = $(el);
            const link = $el.find("a").attr("href");

            // Filtrer les liens toffee.ai (publicités)
            if (!link || link.includes("toffee.ai")) return;

            const title = $el.find(".slide-caption h3 a").text().trim();
            const imageUrl = $el.find("img").attr("src") ?? "";
            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";

            if (mangaId && title) {
                items.push({
                    mangaId,
                    title,
                    imageUrl, // L'image ne s'affichera probablement pas, mais on la met quand même
                    type: "featuredCarouselItem",
                });
            }
        });

        return { items };
    }

    private async getLatestUpdates(): Promise<
        PagedResults<DiscoverSectionItem>
    > {
        const request: Request = {
            url: baseUrl,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        // LATEST MANGA RELEASES : .doreamon .itemupdate.first
        $(".doreamon .itemupdate.first").each((_i, el) => {
            const $el = $(el);
            const link = $el.find("a.cover").attr("href");

            // Filtrer les liens toffee.ai
            if (!link || link.includes("toffee.ai")) return;

            const title = $el.find("h3 a").text().trim();
            const imageUrl =
                $el.find("img").attr("src") ??
                $el.find("img").attr("data-src") ??
                "";
            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";

            // Récupérer le premier chapitre listé
            const latestChapter = $el.find("li .sts a").first().text().trim();

            if (mangaId && title) {
                items.push({
                    mangaId,
                    title,
                    subtitle: latestChapter || undefined,
                    imageUrl,
                    type: "prominentCarouselItem",
                });
            }
        });

        return { items };
    }

    async getSearchFilters(): Promise<SearchFilter[]> {
        return [];
    }

    async getSearchResults(
        query: SearchQuery,
        metadata?: number,
    ): Promise<PagedResults<SearchResultItem>> {
        void metadata;

        const searchQuery = query.title.trim().replace(/\s+/g, "_");
        const request = {
            url: `${baseUrl}/search/story/${searchQuery}`,
            method: "GET" as const,
        };

        const $ = await this.fetchCheerio(request);
        const results: PagedResults<SearchResultItem> = { items: [] };

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
            const subtitle = $el.find("li").first().find("a").text().trim();

            if (mangaId && title) {
                results.items.push({
                    mangaId,
                    title,
                    subtitle: subtitle || undefined,
                    imageUrl,
                });
            }
        });

        return results;
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request: Request = {
            url: `${baseUrl}/manga/${mangaId}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);

        const title = $(".story-info-right h1").text().trim() || mangaId;
        const imageUrl = $(".info-image img").attr("src") ?? "";
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
                thumbnailUrl: imageUrl,
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
        const request: Request = {
            url: `${baseUrl}/manga/${chapter.sourceManga.mangaId}/chapter-${chapter.chapterId}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const pages: string[] = [];

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

    async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
        for (const cookie of this.cookieStorageInterceptor.cookies) {
            this.cookieStorageInterceptor.deleteCookie(cookie);
        }

        for (const cookie of cookies) {
            if (cookie.expires && cookie.expires.getTime() <= Date.now()) {
                continue;
            }
            this.cookieStorageInterceptor.setCookie(cookie);
        }
    }

    checkCloudflareStatus(request: Request, status: number): void {
        if (status == 503 || status == 403) {
            throw new CloudflareError({
                url: request.url,
                method: request.method,
            });
        }
    }

    private async fetchCheerio(request: Request): Promise<CheerioAPI> {
        const [response, data] = await Application.scheduleRequest(request);
        this.checkCloudflareStatus(request, response.status);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }
}

export const Natomanga = new NatomangaExtension();
