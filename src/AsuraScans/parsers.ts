import {
    ContentRating,
    DiscoverSectionType,
    type Chapter,
    type ChapterDetails,
    type DiscoverSectionItem,
    type PagedResults,
    type Request,
    type SearchResultItem,
    type SourceManga,
    type Tag,
    type TagSection,
} from "@paperback/types";
import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import * as htmlparser2 from "htmlparser2";

// -----------------------------------------------------------------------
// Astro SSR props decoder
// The site uses Astro v5 which serialises island props as:
//   { "key": [0, primitive] }  or  { "key": [1, [[0, item], ...]] }
// Objects inside a [0, ...] slot also have their values encoded the same way.
// -----------------------------------------------------------------------

type AstroEncoded = [0, unknown] | [1, AstroEncoded[]];

function decodeAstroValue(val: unknown): unknown {
    if (!Array.isArray(val) || val.length !== 2) return val;
    const [type, value] = val as AstroEncoded;

    if (type === 1 && Array.isArray(value)) {
        return (value as AstroEncoded[]).map(decodeAstroValue);
    }

    if (type === 0) {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            const result: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                result[k] = decodeAstroValue(v);
            }
            return result;
        }
        return value;
    }

    return value;
}

function parseAstroProps(
    htmlStr: string,
    componentName: string,
): Record<string, unknown> | null {
    const escapedName = componentName.replace(/\./g, "\\.");
    const pattern = new RegExp(
        `<astro-island[^>]*component-url="[^"]*${escapedName}[^"]*"[^>]*props="([^"]+)"`,
        "s",
    );
    const match = htmlStr.match(pattern);
    if (!match?.[1]) return null;

    const raw = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&#x27;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        console.error(`[AsuraScans] Failed to parse props for ${componentName}`);
        return null;
    }

    const decoded: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(parsed)) {
        decoded[key] = decodeAstroValue(val);
    }
    return decoded;
}

// -----------------------------------------------------------------------
// Typed data shapes (decoded)
// -----------------------------------------------------------------------

interface AsuraSeriesItem {
    id?: number;
    slug?: string;
    title?: string;
    cover_url?: string;
    cover?: string;
    status?: string;
    author?: string;
    artist?: string;
    rating?: number;
    public_url?: string;
    genres?: { id?: number; name?: string; slug?: string }[];
    latest_chapters?: AsuraChapterItem[];
}

interface AsuraChapterItem {
    id?: number;
    number?: number;
    title?: string;
    slug?: string;
    is_premium?: boolean;
    is_locked?: boolean;
    early_access_until?: string;
    published_at?: string;
    time_ago?: string;
    series_slug?: string;
}

interface AsuraPage {
    url?: string;
    width?: number;
    height?: number;
}

function extractMangaId(url: string): string {
    // /comics/{slug}-{hash}  →  {slug}-{hash}
    const match = url.match(/\/comics\/([^/?#]+)/);
    return match?.[1] ?? "";
}

// -----------------------------------------------------------------------
// Parser class
// -----------------------------------------------------------------------

export class AsuraParser {
    private domain: string;
    private checkStatus: (status: number) => Promise<void>;

    constructor(domain: string, checkStatus: (status: number) => Promise<void>) {
        this.domain = domain;
        this.checkStatus = checkStatus;
    }

    async fetchCheerio(request: Request): Promise<CheerioAPI> {
        const [response, data] = await Application.scheduleRequest(request);
        await this.checkStatus(response.status);
        const html = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(html);
        return cheerio.load(dom);
    }

    async fetchHTML(request: Request): Promise<string> {
        const [response, data] = await Application.scheduleRequest(request);
        await this.checkStatus(response.status);
        return Application.arrayBufferToUTF8String(data);
    }

    // -------------------------------------------------------------------
    // Discover – Featured (hero slider on homepage)
    // -------------------------------------------------------------------

    parseFeatured($: CheerioAPI): PagedResults<DiscoverSectionItem> {
        const items: DiscoverSectionItem[] = [];

        $(".embla-hero__slide a.slide-link").each((_i, el) => {
            const $el = $(el);
            const href = $el.attr("href") ?? "";
            const mangaId = extractMangaId(href);
            if (!mangaId) return;

            const title = $el.find("h3").first().text().trim() || $el.find("img").attr("alt")?.trim() || "";
            const imageUrl = $el.find("img").attr("src") ?? "";

            if (mangaId && title) {
                items.push({ mangaId, title, imageUrl, type: "featuredCarouselItem" });
            }
        });

        console.log(`[AsuraScans] Featured: ${items.length} items`);
        return { items, metadata: undefined };
    }

    // -------------------------------------------------------------------
    // Discover – Trending (Astro island props on homepage)
    // -------------------------------------------------------------------

    parseTrending(htmlStr: string): PagedResults<DiscoverSectionItem> {
        const items: DiscoverSectionItem[] = [];

        const props = parseAstroProps(htmlStr, "TrendingSection");
        const raw = (props?.["items"] as AsuraSeriesItem[] | undefined) ?? [];

        for (const serie of raw) {
            const href = serie.public_url ?? "";
            const mangaId = extractMangaId(href);
            if (!mangaId) continue;

            const title = serie.title ?? "";
            const imageUrl = serie.cover_url ?? serie.cover ?? "";

            if (mangaId && title) {
                items.push({ mangaId, title, imageUrl, type: "simpleCarouselItem" });
            }
        }

        console.log(`[AsuraScans] Trending: ${items.length} items`);
        return { items, metadata: undefined };
    }

    // -------------------------------------------------------------------
    // Discover – Latest Updates (/browse page, BrowseFilters Astro props)
    // -------------------------------------------------------------------

    parseLatestUpdates(htmlStr: string): PagedResults<DiscoverSectionItem> {
        const items: DiscoverSectionItem[] = [];

        const props = parseAstroProps(htmlStr, "BrowseFilters");
        const raw = (props?.["initialSeries"] as AsuraSeriesItem[] | undefined) ?? [];

        for (const serie of raw) {
            const href = serie.public_url ?? "";
            const mangaId = extractMangaId(href);
            if (!mangaId) continue;

            const title = serie.title ?? "";
            const imageUrl = serie.cover_url ?? serie.cover ?? "";

            const latestChapter = serie.latest_chapters?.[0];
            const chapterId = latestChapter?.number !== undefined
                ? String(latestChapter.number)
                : undefined;
            const chapterTitle = latestChapter?.title
                ? `Chapter ${latestChapter.number}`
                : undefined;

            if (mangaId && title && chapterId) {
                items.push({
                    mangaId,
                    title,
                    imageUrl,
                    chapterId,
                    subtitle: chapterTitle,
                    type: "chapterUpdatesCarouselItem",
                });
            }
        }

        console.log(`[AsuraScans] Latest updates: ${items.length} items`);
        return { items, metadata: undefined };
    }

    // -------------------------------------------------------------------
    // Search results (/browse?search=query  →  .series-card elements)
    // -------------------------------------------------------------------

    parseSearchResults($: CheerioAPI): PagedResults<SearchResultItem> {
        const results: SearchResultItem[] = [];

        $(".series-card").each((_i, el) => {
            const $el = $(el);
            const href = $el.find("a[href*='/comics/']").first().attr("href") ?? "";
            const mangaId = extractMangaId(href);
            if (!mangaId) return;

            const title =
                $el.find("h3").first().text().trim() ||
                $el.find("img").attr("alt")?.trim() ||
                "";
            const imageUrl = $el.find("img").attr("src") ?? "";

            if (mangaId && title) {
                results.push({ mangaId, title, imageUrl });
            }
        });

        console.log(`[AsuraScans] Search results: ${results.length}`);
        return { items: results };
    }

    // -------------------------------------------------------------------
    // Manga details – parsed from JSON-LD + HTML
    // -------------------------------------------------------------------

    parseMangaDetails(
        $: CheerioAPI,
        htmlStr: string,
        mangaId: string,
        contentRating: ContentRating,
    ): SourceManga {
        // Prefer JSON-LD ComicSeries for structured data
        let title = mangaId;
        let description = "No description available.";
        let author: string | undefined;
        const tags: Tag[] = [];
        let imageUrl = "";

        $('script[type="application/ld+json"]').each((_i, el) => {
            try {
                const json = JSON.parse($(el).html() ?? "{}") as Record<string, unknown>;
                if (json["@type"] === "ComicSeries") {
                    title = (json["name"] as string) || title;
                    description = (json["description"] as string) || description;
                    author = (json["author"] as Record<string, string> | undefined)?.["name"] || author;
                    imageUrl = (json["image"] as string) || imageUrl;

                    const genres = json["genre"] as string[] | undefined;
                    if (Array.isArray(genres)) {
                        for (const g of genres) {
                            tags.push({ id: g.toLowerCase().replace(/\s+/g, "-"), title: g });
                        }
                    }
                }
            } catch {
                // skip malformed JSON-LD
            }
        });

        // Cover fallback: first CDN cover img on page
        if (!imageUrl) {
            imageUrl =
                $("img[src*='cdn.asurascans.com'][src*='/covers/']").first().attr("src") ?? "";
        }

        // Status: look for the "Status" label and read the adjacent span text
        let status: "ONGOING" | "COMPLETED" | "UNKNOWN" = "UNKNOWN";
        const statusMatch = htmlStr.match(/Status<\/div>\s*<div[^>]*>\s*<span[^>]*><\/span>\s*<span[^>]*capitalize[^>]*>\s*([\w]+)\s*<\/span>/i);
        if (statusMatch?.[1]) {
            const s = statusMatch[1].toLowerCase();
            if (s === "ongoing") status = "ONGOING";
            else if (s === "completed" || s === "complete") status = "COMPLETED";
        }

        const tagSections: TagSection[] =
            tags.length > 0 ? [{ id: "genres", title: "Genres", tags }] : [];

        console.log(`[AsuraScans] Manga: ${title} | ${status}`);

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: imageUrl.startsWith("http") ? imageUrl : "",
                synopsis: description,
                author,
                contentRating,
                status,
                tagGroups: tagSections,
            },
        };
    }

    // -------------------------------------------------------------------
    // Chapter list – parsed from ChapterListReact Astro props
    // -------------------------------------------------------------------

    parseChapters(htmlStr: string, sourceManga: SourceManga): Chapter[] {
        const chapters: Chapter[] = [];

        const props = parseAstroProps(htmlStr, "ChapterListReact");
        const raw = (props?.["chapters"] as AsuraChapterItem[] | undefined) ?? [];

        for (const ch of raw) {
            if (ch.number === undefined) continue;

            const chapterId = String(ch.number);
            const chapNum = ch.number;

            // Append early-access badge to the title when the chapter is still locked
            let title = ch.title ?? undefined;
            if (ch.is_locked) {
                title = title ? `${title} (early access)` : "(early access)";
            }

            let publishDate = new Date();
            if (ch.published_at) {
                const parsed = new Date(ch.published_at);
                if (!isNaN(parsed.getTime())) publishDate = parsed;
            }

            chapters.push({
                chapterId,
                sourceManga,
                langCode: "EN",
                chapNum,
                title,
                publishDate,
            });
        }

        // Props come newest-first; reverse for ascending order
        return chapters.reverse();
    }

    // -------------------------------------------------------------------
    // Chapter details – REST API first, HTML fallback
    //
    // API URL: GET https://api.asurascans.com/api/series/{mangaId}/chapters/{chapterId}
    //   - No auth  → returns pages for free/unlocked chapters
    //   - Bearer   → additionally unlocks early-access chapters for premium users
    // -------------------------------------------------------------------

    async parseChapterDetails(
        mangaId: string,
        chapterId: string,
        accessToken?: string,
    ): Promise<ChapterDetails> {
        // 1. Public API – works for all free/unlocked chapters
        const publicPages = await this.callChapterAPI(mangaId, chapterId);
        if (publicPages.length > 0) {
            console.log(`[AsuraScans] Chapter ${chapterId} – ${publicPages.length} pages (API, no auth)`);
            return { id: chapterId, mangaId, pages: publicPages };
        }

        // 2. Authenticated API – unlocks early-access chapters for premium users
        if (accessToken) {
            const authPages = await this.callChapterAPI(mangaId, chapterId, accessToken);
            if (authPages.length > 0) {
                console.log(`[AsuraScans] Chapter ${chapterId} – ${authPages.length} pages (API, auth)`);
                return { id: chapterId, mangaId, pages: authPages };
            }
            throw new Error(
                "Chapter is still under early access and your account does not have premium access.",
            );
        }

        // 3. HTML fallback (covers edge cases where the API is unavailable)
        const request: Request = {
            url: `${this.domain}/comics/${mangaId}/chapter/${chapterId}`,
            method: "GET",
        };
        const htmlStr = await this.fetchHTML(request);
        const props = parseAstroProps(htmlStr, "ChapterReader");
        const rawPages = (props?.["pages"] as AsuraPage[] | undefined) ?? [];
        const pages = rawPages.map((p) => p.url ?? "").filter((u) => u.startsWith("http"));

        if (pages.length > 0) {
            console.log(`[AsuraScans] Chapter ${chapterId} – ${pages.length} pages (HTML fallback)`);
            return { id: chapterId, mangaId, pages };
        }

        const unlockTime = props?.["unlockTime"] as string | null;
        const msg = unlockTime
            ? `Chapter is under early access until ${new Date(unlockTime).toLocaleString()}. Login with a premium account to read it now.`
            : "Chapter requires a premium account. Login in the extension settings.";
        throw new Error(msg);
    }

    private async callChapterAPI(
        mangaId: string,
        chapterId: string,
        accessToken?: string,
    ): Promise<string[]> {
        const headers: Record<string, string> = {
            Accept: "application/json",
            Origin: "https://asurascans.com",
            Referer: "https://asurascans.com/",
        };
        if (accessToken) {
            headers["Authorization"] = `Bearer ${accessToken}`;
        }

        let response: { status: number };
        let data: ArrayBuffer;
        try {
            [response, data] = await Application.scheduleRequest({
                url: `https://api.asurascans.com/api/series/${mangaId}/chapters/${chapterId}`,
                method: "GET",
                headers,
            });
        } catch {
            return [];
        }

        if (response.status !== 200) {
            console.log(`[AsuraScans] API ${response.status} for ${mangaId}/ch${chapterId}`);
            return [];
        }

        const json = JSON.parse(
            Application.arrayBufferToUTF8String(data),
        ) as Record<string, unknown>;

        const chapter = (
            (json["data"] as Record<string, unknown> | undefined)?.["chapter"]
        ) as Record<string, unknown> | undefined;

        const apiPages = (chapter?.["pages"] as AsuraPage[]) ?? [];
        return apiPages
            .map((p) => p.url ?? "")
            .filter((u) => u.startsWith("http"));
    }
}
