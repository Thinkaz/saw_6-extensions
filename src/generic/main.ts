import {
    BasicRateLimiter,
    ContentRating,
    CookieStorageInterceptor,
    DiscoverSectionType,
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
    type SourceManga,
} from "@paperback/types";
import { AnimaceInterceptor, fetchRequest } from "./network";
import { AnimaceParser } from "./parsers";
import { AnimaceHelper, generateChapterToken } from "./utils";

type AnimaceImplementation = Extension &
    DiscoverSectionProviding &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    CloudflareBypassRequestProviding;

export interface AnimaceConfig {
    domain: string;
    name: string;
    contentRating: ContentRating;
    language: string;
    basicRateLimiter?: {
        numberOfRequests: number;
        bufferInterval: number;
        ignoreImages?: boolean;
    };
}

export class AnimaceGeneric implements AnimaceImplementation {
    protected domain: string;
    protected name: string;
    protected contentRating: ContentRating;
    protected language: string;
    protected mainRateLimiter: BasicRateLimiter;

    mainInterceptor: AnimaceInterceptor;
    cookieStorageInterceptor: CookieStorageInterceptor;
    parser: AnimaceParser;
    helper: AnimaceHelper;

    constructor(config: AnimaceConfig) {
        this.domain = config.domain;
        this.name = config.name;
        this.contentRating = config.contentRating;
        this.language = config.language;
        this.mainRateLimiter = new BasicRateLimiter("main", {
            numberOfRequests: config.basicRateLimiter?.numberOfRequests ?? 4,
            bufferInterval: config.basicRateLimiter?.bufferInterval ?? 1,
            ignoreImages: config.basicRateLimiter?.ignoreImages ?? true,
        });

        this.mainInterceptor = new AnimaceInterceptor("main", this.domain);
        this.cookieStorageInterceptor = new CookieStorageInterceptor({
            storage: "stateManager",
        });

        this.helper = new AnimaceHelper(this.domain);
        this.parser = new AnimaceParser(this.domain);
    }

    async initialise(): Promise<void> {
        this.mainRateLimiter.registerInterceptor();
        this.mainInterceptor.registerInterceptor();
        this.cookieStorageInterceptor.registerInterceptor();
    }

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            {
                id: "popular",
                title: "Popular",
                subtitle: "Most popular series",
                type: DiscoverSectionType.featured,
            },
            {
                id: "latest",
                title: "Latest Updates",
                subtitle: "Recently updated chapters",
                type: DiscoverSectionType.chapterUpdates,
            },
            {
                id: "highscore",
                title: "Top Rated",
                subtitle: "Highest rated series",
                type: DiscoverSectionType.simpleCarousel,
            },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: number | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = metadata ?? 1;

        if (section.id === "highscore") {
            const request: Request = {
                url: `${this.domain}/wp-json/manga/v1/highscore?number=15`,
                method: "GET",
            };
            const json = await fetchRequest(request);
            return this.parser.parseHighscoreItems(json);
        } else if (section.id === "latest") {
            const request: Request = {
                url: `${this.domain}/wp-json/manga/v1/latest-chapters`,
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ page }),
            };
            const json = await fetchRequest(request);
            return this.parser.parseLatestUpdates(json, page);
        } else {
            const request: Request = {
                url: `${this.domain}/wp-json/manga/v1/popular?number=15`,
                method: "GET",
            };
            const json = await fetchRequest(request);
            return this.parser.parsePopularItems(json, section.type);
        }
    }

    async getSearchFilters(): Promise<SearchFilter[]> {
        return [];
    }

    async getSearchResults(query: SearchQuery): Promise<PagedResults<SearchResultItem>> {
        if (!query.title || query.title.trim() === "") {
            return { items: [] };
        }

        const request: Request = {
            url: `${this.domain}/wp-json/manga/v1/search`,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: query.title.trim() }),
        };

        const json = await fetchRequest(request);
        return this.parser.parseSearchResults(json);
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request: Request = {
            url: `${this.domain}/manga/${mangaId}/`,
            method: "GET",
        };

        const html = await fetchRequest(request);
        return this.parser.parseMangaDetails(html, mangaId, this.contentRating);
    }

    async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
        void sinceDate;

        // First fetch the manga page to get the numeric manga ID
        const pageRequest: Request = {
            url: `${this.domain}/manga/${sourceManga.mangaId}/`,
            method: "GET",
        };
        const html = await fetchRequest(pageRequest);
        const numericId = this.parser.extractMangaNumericId(html);

        if (!numericId) {
            throw new Error(`Could not find numeric manga ID for ${sourceManga.mangaId}`);
        }

        // Generate auth token for chapter API
        const { token, timestamp } = generateChapterToken();

        const queryString =
            `manga_id=${numericId}&offset=0&limit=500&order=DESC` +
            `&_t=${token}&_ts=${timestamp}`;

        const request: Request = {
            url: `${this.domain}/auth/manga-chapters?${queryString}`,
            method: "GET",
        };

        const json = await fetchRequest(request);
        return this.parser.parseChapters(json, sourceManga);
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const request: Request = {
            url: `${this.domain}/auth/chapter-content?chapter_id=${chapter.chapterId}`,
            method: "GET",
        };

        const json = await fetchRequest(request);
        return this.parser.parseChapterDetails(json, chapter.chapterId, chapter.sourceManga.mangaId);
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
    }

    async getCloudflareBypassRequest(): Promise<Request> {
        return {
            url: this.domain,
            method: "GET",
            headers: {
                referer: this.domain,
                origin: this.domain,
            },
        };
    }
}
