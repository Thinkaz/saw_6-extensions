import {
    BasicRateLimiter,
    CloudflareError,
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
} from "@paperback/types";
import { AsuraInterceptor } from "./network";
import { AsuraParser } from "./parsers";
import { AsuraSettingsForm } from "./forms";
import pbconfig from "./pbconfig";

const DOMAIN = "https://asurascans.com";

type AsuraImplementation = Extension &
    SettingsFormProviding &
    DiscoverSectionProviding &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    CloudflareBypassRequestProviding;

export class AsuraScansExtension implements AsuraImplementation {
    mainRateLimiter = new BasicRateLimiter("main", {
        numberOfRequests: 4,
        bufferInterval: 1,
        ignoreImages: true,
    });

    mainInterceptor = new AsuraInterceptor("main", DOMAIN);
    cookieStorageInterceptor = new CookieStorageInterceptor({
        storage: "stateManager",
    });
    parser: AsuraParser;

    constructor() {
        this.parser = new AsuraParser(DOMAIN, (status) =>
            this.checkCloudflareStatus(status),
        );
    }

    async initialise(): Promise<void> {
        this.mainRateLimiter.registerInterceptor();
        this.mainInterceptor.registerInterceptor();
        this.cookieStorageInterceptor.registerInterceptor();
    }

    async getSettingsForm(): Promise<Form> {
        return new AsuraSettingsForm();
    }

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            {
                id: "featured",
                title: "Featured",
                subtitle: "Editor's picks",
                type: DiscoverSectionType.featured,
            },
            {
                id: "trending",
                title: "Trending Today",
                subtitle: "Most viewed series",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "latest",
                title: "Latest Updates",
                subtitle: "Recently updated series",
                type: DiscoverSectionType.chapterUpdates,
            },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: number | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        void metadata;

        if (section.id === "latest") {
            const request: Request = { url: `${DOMAIN}/browse`, method: "GET" };
            const htmlStr = await this.parser.fetchHTML(request);
            return this.parser.parseLatestUpdates(htmlStr);
        }

        // featured and trending both come from the homepage
        const request: Request = { url: DOMAIN, method: "GET" };

        if (section.id === "featured") {
            const $ = await this.parser.fetchCheerio(request);
            return this.parser.parseFeatured($);
        } else {
            const htmlStr = await this.parser.fetchHTML(request);
            return this.parser.parseTrending(htmlStr);
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
        const request: Request = {
            url: `${DOMAIN}/browse?search=${searchQuery}`,
            method: "GET",
        };

        const $ = await this.parser.fetchCheerio(request);
        return this.parser.parseSearchResults($);
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request: Request = {
            url: `${DOMAIN}/comics/${mangaId}`,
            method: "GET",
        };

        const htmlStr = await this.parser.fetchHTML(request);
        const dom = await import("htmlparser2").then((m) =>
            m.parseDocument(htmlStr),
        );
        const $ = await import("cheerio").then((m) => m.load(dom));

        return this.parser.parseMangaDetails($, htmlStr, mangaId, pbconfig.contentRating);
    }

    async getChapters(
        sourceManga: SourceManga,
        sinceDate?: Date,
    ): Promise<Chapter[]> {
        void sinceDate;

        const request: Request = {
            url: `${DOMAIN}/comics/${sourceManga.mangaId}`,
            method: "GET",
        };

        const htmlStr = await this.parser.fetchHTML(request);
        return this.parser.parseChapters(htmlStr, sourceManga);
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const accessToken = Application.getSecureState("asura_access_token") as
            | string
            | undefined;

        return this.parser.parseChapterDetails(
            chapter.sourceManga.mangaId,
            chapter.chapterId,
            accessToken ?? undefined,
        );
    }

    async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
        for (const cookie of this.cookieStorageInterceptor.cookies) {
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
            url: DOMAIN,
            method: "GET",
            headers: { referer: DOMAIN, origin: DOMAIN },
        };
    }

    getMangaShareUrl(mangaId: string): string {
        return `${DOMAIN}/comics/${mangaId}`;
    }

    private async checkCloudflareStatus(status: number): Promise<void> {
        console.log(`[AsuraScans] Response status: ${status}`);
        switch (status) {
            case 503:
            case 403:
                throw new CloudflareError(
                    {
                        url: DOMAIN,
                        method: "GET",
                        headers: { referer: DOMAIN, origin: DOMAIN },
                    },
                    "Cloudflare bypass required, please complete the challenge.",
                );
            case 404:
                throw new Error("Content not found");
        }
    }
}

export const AsuraScans = new AsuraScansExtension();
