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
import { decodeHTML } from "entities"; // Ajout de la dépendance pour décoder les titres
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
    }

    async getSettingsForm(): Promise<Form> {
        return new SettingsForm();
    }

    // ### CORRECTION 1 : Définition des sections (basée sur la v0.8) ###
    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            {
                id: "4", // filter=4 (Latest Updates)
                title: "Latest Updates",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "1", // filter=1 (Newest)
                title: "New Titles",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "7", // filter=7 (Popular)
                title: "Most Popular",
                type: DiscoverSectionType.simpleCarousel,
            },
        ];
    }

    // ### CORRECTION 2 : Logique de Discover (basée sur la v0.8) ###
    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: number | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = metadata ?? 1;

        // L'URL vient de la logique v0.8 (mangaListPath + mangaListHomeSectionsPath + filter)
        const request: Request = {
            url: `${baseUrl}/genre/all?filter=${section.id}&page=${page}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        // Sélecteur de la v0.8 (mangaListSelector)
        $("div.comic-list div.list-comic-item-wrap").each((_i, el) => {
            const $el = $(el);

            // Sélecteur de titre/lien de la v0.8 (implicite)
            const link = $el.find("a.list-story-item").attr("href");
            if (!link) return;

            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";
            const title = $el.find("h3 a").first().text().trim();
            const imageUrl =
                $el.find("img").attr("src") ??
                $el.find("img").attr("data-src") ??
                "";

            // Sélecteur de sous-titre de la v0.8 (mangaSubtitleSelector)
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
                    // Le type est déterminé par la section, pas par le scraping
                    type:
                        section.type === DiscoverSectionType.simpleCarousel
                            ? "prominentCarouselItem"
                            : "simpleCarouselItem",
                });
            }
        });

        // Logique de pagination (basée sur la v0.8 isLastPage)
        const hasNextPage =
            $(".pagination-out").length > 0 &&
            $(".pagination-list li.pagination-next").length > 0;

        return {
            items,
            metadata: hasNextPage ? page + 1 : undefined,
        };
    }

    async getSearchFilters(): Promise<SearchFilter[]> {
        // Cette fonction est correcte.
        // Vous pouvez l'étendre plus tard pour utiliser les genres de la v0.8.
        return [
            {
                id: "search-filter-template",
                type: "dropdown",
                options: [
                    { id: "include", value: "include" },
                    { id: "exclude", value: "exclude" },
                ],
                value: "include",
                title: "Search Filter Template",
            },
        ];
    }

    // ### CORRECTION 3 : Logique de Recherche (basée sur la v0.8) ###
    async getSearchResults(
        query: SearchQuery,
        metadata?: number,
    ): Promise<PagedResults<SearchResultItem>> {
        const page = metadata ?? 1;

        // Logique d'URL de la v0.8
        const searchQuery = query.title.trim().replace(/\s+/g, "_");
        const request = {
            url: `${baseUrl}/search/story/${searchQuery}?page=${page}`,
            method: "GET" as const,
        };

        const $ = await this.fetchCheerio(request);
        const results: PagedResults<SearchResultItem> = { items: [] };

        // Sélecteur de la v0.8 pour la recherche par titre
        $("div.panel_story_list div.story_item").each((_i, el) => {
            const $el = $(el);

            // Logique de la v0.8
            const link = $el.find("a").first().attr("href");
            if (!link) return;

            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";
            const imageUrl = $el.find("img").first().attr("src") ?? "";
            const title = decodeHTML(
                $el.find("h3.story_name a").first().text().trim() ?? "",
            );
            const subtitle = decodeHTML(
                $el.find("h3.story_name + em.story_chapter a").text().trim() ??
                    "",
            );

            if (mangaId && title) {
                results.items.push({
                    mangaId,
                    title,
                    subtitle: subtitle || "No Chapters",
                    imageUrl,
                });
            }
        });

        // Logique de pagination (basée sur la v0.8 isLastPage)
        const hasNextPage =
            $(".pagination-out").length > 0 &&
            $(".pagination-list li.pagination-next").length > 0;

        return {
            items: results.items,
            metadata: hasNextPage ? page + 1 : undefined,
        };
    }

    // =================================================================
    // LES FONCTIONS SUIVANTES (DETAILS, CHAPTERS) SONT CORRECTES
    // ELLES CORRESPONDENT DÉJÀ À LA LOGIQUE DE LA v0.8
    // =================================================================

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
        // Sélecteur v0.8: 'div.story-info-right td:contains(Genre) + td a'
        // Sélecteur v0.9: '.variations-tableInfo .table-value a.a-h'
        // Les deux ciblent les genres, celui de la v0.9 est OK.
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

        // Sélecteur v0.8: 'div.panel-story-chapter-list ul.row-content-chapter li'
        // Sélecteur v0.9: '.row-content-chapter li'
        // Le sélecteur v0.9 est correct et correspond.
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

        // Sélecteur v0.8: 'div.container-chapter-reader img'
        // Sélecteur v0.9: '.container-chapter-reader img'
        // Le sélecteur v0.9 est correct et correspond.
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

    // =================================================================
    // GESTION CLOUDFLARE (Déjà correcte)
    // =================================================================

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
