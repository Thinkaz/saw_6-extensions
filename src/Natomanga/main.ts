import {
    BasicRateLimiter,
    ContentRating,
    DiscoverSectionType,
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
    type SourceManga,
    type TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import * as htmlparser2 from "htmlparser2";
import { MainInterceptor } from "./network";

const BASE_URL = "https://kagane.org";
const API_URL = "https://api.kagane.org/api/v1";

type KaganeImplementation = Extension &
    DiscoverSectionProviding &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding;

export class KaganeExtension implements KaganeImplementation {
    mainRateLimiter = new BasicRateLimiter("main", {
        numberOfRequests: 5,
        bufferInterval: 1,
        ignoreImages: true,
    });

    mainInterceptor = new MainInterceptor("main");

    async initialise(): Promise<void> {
        this.mainRateLimiter.registerInterceptor();
        this.mainInterceptor.registerInterceptor();
    }

    // --- DISCOVER SECTIONS ---
    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            {
                id: "recentlyUpdated",
                title: "Recently Updated",
                subtitle: "Updates from the homepage",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "recentlyAdded",
                title: "Recently Added",
                subtitle: "New series added to the library",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "popular",
                title: "Popular",
                subtitle: "Most popular series (Today)",
                type: DiscoverSectionType.prominentCarousel,
            },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: number | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const request: Request = {
            url: BASE_URL,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        let containerId = "";
        if (section.id === "recentlyUpdated") containerId = "#section\\:recentlyUpdated-content";
        else if (section.id === "recentlyAdded") containerId = "#section\\:recentlyAdded-content";
        else if (section.id === "popular") containerId = "#popular-content";

        const container = $(containerId);

        container.find('div[data-slot="carousel-item"]').each((_i, el) => {
            const $el = $(el);
            const link = $el.find('a[href^="/series/"]').attr("href");
            if (!link) return;
            const mangaId = link.split("/series/")[1];
            if (!mangaId) return;

            const imageUrl = `${API_URL}/series/${mangaId}/thumbnail`;
            const title = $el.find("h3").text().trim();
            const chapterCount = $el.find('svg.lucide-book-open').parent().text().trim();
            
            items.push({
                mangaId: mangaId,
                title: title,
                imageUrl: imageUrl,
                subtitle: chapterCount ? `${chapterCount} chapters` : undefined,
                type: section.type === DiscoverSectionType.prominentCarousel ? "prominentCarouselItem" : "simpleCarouselItem",
            });
        });

        return { items, metadata: undefined };
    }

    // --- MANGA DETAILS ---
    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request: Request = {
            url: `${API_URL}/series/${mangaId}`,
            method: "GET",
        };

        try {
            const [_, data] = await Application.scheduleRequest(request);
            const json = JSON.parse(Application.arrayBufferToUTF8String(data));
            const series = json.data || json;

            const tags: TagSection[] = [];
            const allTags: string[] = [];

            if (series.genres && Array.isArray(series.genres)) allTags.push(...series.genres);
            if (series.tags && Array.isArray(series.tags)) allTags.push(...series.tags);

            if (allTags.length > 0) {
                tags.push({
                    id: "genres",
                    title: "Genres",
                    tags: allTags.map((tag: any) => {
                        const title = typeof tag === 'string' ? tag : (tag.name || "");
                        const id = title.trim().toLowerCase().replace(/\s+/g, "-"); 
                        return { id, title };
                    })
                });
            }

            return {
                mangaId,
                mangaInfo: {
                    primaryTitle: series.name || series.title || "Unknown Title",
                    thumbnailUrl: `${API_URL}/series/${mangaId}/thumbnail`,
                    synopsis: series.summary || series.description || "",
                    contentRating: ContentRating.MATURE,
                    status: series.status === "ONGOING" ? "ONGOING" : "COMPLETED",
                    author: Array.isArray(series.authors) ? series.authors.join(", ") : series.author,
                    tagGroups: tags,
                },
            };
        } catch (e) {
            // Fallback HTML
            const req = { url: `${BASE_URL}/series/${mangaId}`, method: "GET" as const };
            const $ = await this.fetchCheerio(req);
            return {
                mangaId,
                mangaInfo: {
                    primaryTitle: $("h1").first().text().trim(),
                    thumbnailUrl: `${API_URL}/series/${mangaId}/thumbnail`,
                    synopsis: $("p.leading-relaxed").first().text().trim(),
                    contentRating: ContentRating.MATURE,
                    status: "UNKNOWN",
                    tagGroups: []
                }
            };
        }
    }

    // --- CHAPTERS ---
    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const chapters: Chapter[] = [];
        const request: Request = {
            url: `${BASE_URL}/series/${sourceManga.mangaId}`,
            method: "GET",
        };

        const [_, data] = await Application.scheduleRequest(request);
        const html = Application.arrayBufferToUTF8String(data);

        try {
            const regex = /\\?"initialBooksData\\?":(\[.*?\])(?:,\\?"viewsData\\?"|,\s*\\?"metadata)/;
            const match = html.match(regex);

            if (match && match[1]) {
                const cleanJson = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                const rawBooks = JSON.parse(cleanJson);

                for (const book of rawBooks) {
                    const title = book.name || book.title || "";
                    let chapNum = 0;
                    if (book.metadata && book.metadata.numberSort) {
                        chapNum = parseFloat(book.metadata.numberSort);
                    } else {
                        const numMatch = title.match(/(\d+(\.\d+)?)/);
                        if (numMatch && numMatch[1]) chapNum = parseFloat(numMatch[1]);
                    }

                    let date = new Date();
                    if (book.metadata && book.metadata.releaseDate) {
                        date = new Date(book.metadata.releaseDate);
                    } else if (book.created) {
                        date = new Date(book.created);
                    }

                    chapters.push({
                        chapterId: book.id,
                        sourceManga,
                        title: title,
                        chapNum: isNaN(chapNum) ? 0 : chapNum,
                        langCode: "en",
                        publishDate: date,
                    });
                }
            }
        } catch (e) {
            console.error(`[Kagane] Chapters extraction failed: ${e}`);
        }

        return chapters.sort((a, b) => (b.chapNum ?? 0) - (a.chapNum ?? 0));
    }

    // --- READER (CORRECTED 'body') ---
    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const mangaId = chapter.sourceManga.mangaId;
        const chapterId = chapter.chapterId;
        const readerUrl = `${BASE_URL}/series/${mangaId}/reader/${chapterId}`;

        // LE CHALLENGE (Votre chaîne extraite)
        const challengeData = "CAESuhwSKgooChISEGZkLftZfg/yK5NVNJucckUQARoQLiInmJstcDZFYEygbeACJxgBIJm5k8kGMBY428bS2whC7hsKEnN0YWdpbmcuZ29vZ2xlLmNvbRIQKHA0VMAI9jYYredEPbbEyBqwGY6BFRoOIVxXYUgZ0zbbirE56ZWsSX3f4BeceYJelkCVtYjDs0EPRqcRMCSVFJMp6bhfzoi2K5FfqKJwMGFxxgyDHyJKHddFsXxGDh1Df1eP4YaLgdH1q5dokZXxOCtNWWPNUL+kmG5fv1HujNvbz7oiqiW3Uzptv/Y5sm8abp3reDr7TWIadoC00tAEBKFiG0HNvGNb//+a6f4zms7SS8e4LUHcgJxgrk8zSOalM7s0sIVo0wV3FhsgVIIDobGWbDSs8VBX0i+uqTceWOUXpBjV7w+XiFZNLLXvB0GcdXivM1Xp7tFbRLj3++JBH3aLW6IwGeJxp06sS6rzUs+DvQAeSO/ekvlznAF6rCaZNyfMDEK...N+Q1IbNxuLnQ53nwjSrNruA9b4xKHhoNA8uYtqSoVoLnnpqajwsN8raibZCzIMuJ9QEoyP4h0c6VIVgCo7o6W20d/8LWjUspIE1CacGtUr36rzOU1tXmL68d0pNNmdmCu5XmBvSYXIxU2s8BcHbEhFYvKUH2cDytsbWtZpCWhYB+9unKmit8qpKtrdy8oz2XkbW62Dh30TWZdkWYb+9Z5lF5LShxDciybeNJX4OovM7GR+Z9EutqR7UvLPqXBlTD7H6ektwjQj2lBQQgdF2NPfB4PB+wNzvUoLNC4xMC4yODkxLjAagAEScG/6tC5dGEVMkn3TsRtQ+FBQWMPKuJDRJbMAW515lcjZS2cfUz/pOY8rsOv6MqcyTrqYNq39PTfI/gAwIB7HJzR2YBuONeCbG4RWE1NQbUXCyVo9OvaAUM6m1c8622WM1s9Nt3q+vyvC4CJPvjWAA8ScjQo1ZWZiw8fromF5YkoUAAAAAQAAABQABQAQi3SjW1x2agQ=";

        // 1. POST TOKEN
        const accessRequest: Request = {
            url: `${API_URL}/books/${mangaId}/file/${chapterId}`,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Origin": BASE_URL,
                "Referer": readerUrl
            },
            // CORRECTION: 'body' au lieu de 'data'
            body: JSON.stringify({
                challenge: challengeData
            })
        };

        // 2. GET METADATA
        const metadataRequest: Request = {
            url: `${API_URL}/books/${mangaId}/metadata/${chapterId}`,
            method: "GET",
            headers: { "Referer": readerUrl }
        };

        try {
            const [accessRes, metadataRes] = await Promise.all([
                Application.scheduleRequest(accessRequest),
                Application.scheduleRequest(metadataRequest)
            ]);

            let token = "";
            let cacheUrl = "https://kazana.kagane.org";

            if (accessRes.status === 200) {
                const accessJson = JSON.parse(Application.arrayBufferToUTF8String(accessRes.data));
                token = accessJson.access_token;
                cacheUrl = accessJson.cache_url || cacheUrl;
            } else {
                console.log(`[Kagane] Token rejected: ${accessRes.status}. Attempting bypass.`);
            }

            if (metadataRes.status !== 200) throw new Error(`Metadata Failed (${metadataRes.status})`);
            
            const metaJson = JSON.parse(Application.arrayBufferToUTF8String(metadataRes.data));
            const images = metaJson.image_dimensions;

            if (!images || !Array.isArray(images)) throw new Error("No images found");

            // Construction des URLs
            const pages: string[] = images.map((img: any) => {
                const baseUrl = cacheUrl.replace(/\/$/, "");
                let url = `${baseUrl}/api/v1/books/${mangaId}/file/${chapterId}/${img.page}`;
                if (token) url += `?token=${token}`;
                return url;
            });

            return {
                id: chapterId,
                mangaId: mangaId,
                pages: pages,
            };

        } catch (e) {
            console.error(`[Kagane] Error: ${e}`);
            // Retourne la miniature en cas d'erreur pour ne pas crasher
            return {
                id: chapterId,
                mangaId: mangaId,
                pages: [`${API_URL}/series/${mangaId}/thumbnail`]
            };
        }
    }

    // --- UTILS ---
    private async fetchCheerio(request: Request): Promise<CheerioAPI> {
        const [response, data] = await Application.scheduleRequest(request);
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }

    async getSearchFilters(): Promise<SearchFilter[]> { return []; }
    async getSearchResults(query: SearchQuery, metadata?: number): Promise<PagedResults<SearchResultItem>> { return { items: [] }; }
}

export const Kagane = new KaganeExtension();