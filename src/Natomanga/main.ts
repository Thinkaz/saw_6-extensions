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
    }

    async getSettingsForm(): Promise<Form> {
        return new SettingsForm();
    }

    // Fonction utilitaire pour obtenir le serveur d'images depuis les réglages (recréée à partir de MangaBoxSettings.ts)
    private async getImageServerIndex(): Promise<number> {
        const server = (await Application.getState("image_server")) as
            | string[]
            | undefined;
        // La valeur stockée est ['server1'] ou ['server2']. On convertit en index 0 ou 1.
        return parseInt(server?.[0]?.replace("server", "") ?? "1") - 1;
    }

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        // IDs utilisés ici: 4 (Latest), 1 (New), 7 (Popular)
        return [
            {
                id: "4", // Latest Updates
                title: "Latest Updates",
                subtitle: "The most recently updated chapters",
                type: DiscoverSectionType.prominentCarousel,
            },
            {
                id: "1", // New Titles
                title: "New Titles",
                subtitle: "Recently added manga to the source",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "7", // Most Popular
                title: "Most Popular",
                subtitle: "Titles with the most views",
                type: DiscoverSectionType.simpleCarousel,
            },
        ];
    }

    /**
     * CORRECTION 3: Gère la pagination en appelant l'URL /genre/all?filter=...
     * La page d'accueil ne suffit pas pour 'Voir plus'.
     */
    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: number | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = metadata ?? 1;

        const request: Request = {
            // L'URL pour le bouton 'Voir Plus'
            url: `${baseUrl}/genre/all?filter=${section.id}&page=${page}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        // Déterminer le type d'item basé sur le type de section
        const itemType: "prominentCarouselItem" | "simpleCarouselItem" =
            section.type === DiscoverSectionType.prominentCarousel
                ? "prominentCarouselItem"
                : "simpleCarouselItem";

        // Sélecteur v0.8 (testé et fonctionnel pour cette page)
        $("div.comic-list div.list-comic-item-wrap").each((_i, el) => {
            const $el = $(el);

            const link = $el.find("a.list-story-item").attr("href");
            if (!link) return;

            const mangaId = link.split("/manga/")[1]?.split("?")[0] ?? "";
            const title = $el.find("h3 a").first().text().trim();

            // Correction d'image (fixe les chemins relatifs)
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

        // Vérification de la pagination pour déterminer s'il y a plus de pages
        const hasNextPage =
            $(".pagination-out").length > 0 &&
            $(".pagination-list li.pagination-next").length > 0;

        return {
            items,
            metadata: hasNextPage ? page + 1 : undefined, // metadata contiendra le prochain numéro de page
        };
    }

    async getSearchFilters(): Promise<SearchFilter[]> {
        // Laissez ceci pour l'instant, mais la recherche sur Natomanga ne semble pas utiliser de filtres complexes.
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

        // Sélecteur v0.8
        $(".doreamon .itemupdate.first").each((_i, el) => {
            const $el = $(el);
            const link = $el.find("a.cover").attr("href");
            if (!link) return;

            const title = $el.find("h3 a").first().text().trim();
            const rawImageUrl =
                $el.find("img").attr("src") ??
                $el.find("img").attr("data-src") ??
                "";
            const imageUrl = this.fixImageUrl(rawImageUrl); // Correction d'image
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

        // La recherche ne semble pas avoir de pagination facilement parsable. On laisse un undefined.
        return { items: results.items };
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request: Request = {
            url: `${baseUrl}/manga/${mangaId}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);

        const title = $(".story-info-right h1").text().trim() || mangaId;
        const rawImageUrl = $(".info-image img").attr("src") ?? "";
        const imageUrl = this.fixImageUrl(rawImageUrl); // Correction d'image
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

        // Note: Natomanga trie les chapitres du plus récent au plus ancien dans le HTML
        $(".row-content-chapter li").each((i, el) => {
            const $el = $(el);
            const chapterLink = $el.find("a").attr("href");

            if (!chapterLink) return;

            const chapterId = chapterLink.split("/chapter-")[1] ?? `${i}`;
            const chapterTitle = $el.find("a").text().trim();

            // Tentative d'extraction du numéro de chapitre
            const chapterMatch = chapterTitle.match(
                /chapter\s+(\d+(?:\.\d+)?)/i,
            );
            const chapNum =
                chapterMatch && chapterMatch[1]
                    ? parseFloat(chapterMatch[1])
                    : i + 1; // Fallback au numéro d'index

            chapters.push({
                chapterId,
                sourceManga,
                langCode: "EN",
                chapNum,
                title: chapterTitle,
                volume: undefined,
                // Le tri est fait par Paperback, on n'a pas besoin de sortingIndex explicite ici.
            });
        });

        return chapters;
    }

    /**
     * CORRECTION 1: Ajout de la logique de sélection de CDN pour les pages.
     */
    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const request: Request = {
            url: `${baseUrl}/manga/${chapter.sourceManga.mangaId}/chapter-${chapter.chapterId}`,
            method: "GET",
        };

        const [response, data] = await Application.scheduleRequest(request);
        this.checkCloudflareStatus(request, response.status);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const $ = cheerio.load(htmlStr); // Ne pas utiliser htmlparser2 car nous avons besoin de l'HTML brut pour le script

        const pages: string[] = [];

        // 1. Déterminer l'index du serveur d'images
        const imageServerIndex = await this.getImageServerIndex();

        // 2. Tenter d'extraire la liste des CDN
        let cdns: string[] = [];
        const scriptMatch = $("head")
            .html()
            ?.match(/var cdns = \[(.*?)\];/s);
        if (scriptMatch && scriptMatch[1]) {
            try {
                // Créer une chaîne JSON valide en remplaçant les guillemets simples (s'il y en a)
                const cdnString = `[${scriptMatch[1].replace(/'/g, '"')}]`;
                const parsed = JSON.parse(cdnString) as unknown;
                if (
                    Array.isArray(parsed) &&
                    parsed.every((p) => typeof p === "string")
                ) {
                    cdns = parsed;
                } else {
                    console.warn(
                        "CDN list parsed but is not an array of strings:",
                        parsed,
                    );
                }
            } catch (e) {
                console.error("Failed to parse CDN list:", e);
            }
        }

        // 3. Boucler sur les images et appliquer la correction de CDN si possible
        $(".container-chapter-reader img").each((_i, el) => {
            let imgUrl = $(el).attr("src") ?? $(el).attr("data-src");
            if (!imgUrl) return;

            // Correction 1: Remplacement du CDN si la liste est disponible
            if (
                cdns.length > 0 &&
                imageServerIndex >= 0 &&
                imageServerIndex < cdns.length
            ) {
                const newCdn = cdns[imageServerIndex];
                // Le code v0.8 fait une substitution globale
                for (const cdnUrl of cdns) {
                    imgUrl = imgUrl.replace(cdnUrl, newCdn ?? "");
                }
            }

            // Correction 2: Correction générale (relatif, //)
            pages.push(this.fixImageUrl(imgUrl));
        });

        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            pages,
        };
    }

    /**
     * CORRECTION 2: Assure la persistance des cookies Cloudflare.
     */
    async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
        // Vider les cookies existants avant d'enregistrer les nouveaux
        for (const cookie of this.cookieStorageInterceptor.cookies) {
            this.cookieStorageInterceptor.deleteCookie(cookie);
        }

        // Enregistrer les nouveaux cookies
        for (const cookie of cookies) {
            // S'assurer que le cookie n'est pas expiré
            if (cookie.expires && cookie.expires.getTime() <= Date.now()) {
                continue;
            }
            this.cookieStorageInterceptor.setCookie(cookie);
        }
    }

    checkCloudflareStatus(request: Request, status: number): void {
        if (status == 503 || status == 403) {
            // Lancer l'erreur Cloudflare avec les détails de la requête
            throw new CloudflareError({
                url: request.url,
                method: request.method,
            });
        }
    }

    // =================================================================
    // FONCTIONS UTILITAIRES
    // =================================================================

    /**
     * Corrige les URL d'images relatives ou celles commençant par //
     */
    private fixImageUrl(url: string): string {
        if (!url) return "";

        // Gère les URL commençant par // (ex: //example.com/img.png)
        if (url.startsWith("//")) {
            return "https:" + url;
        }

        // Gère les URL relatives (ex: /images/img.png)
        if (url.startsWith("/")) {
            return baseUrl + url;
        }

        return url;
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
