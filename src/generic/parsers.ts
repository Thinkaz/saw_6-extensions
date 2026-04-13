import {
    ContentRating,
    DiscoverSectionType,
    type Chapter,
    type ChapterDetails,
    type DiscoverSectionItem,
    type PagedResults,
    type SearchResultItem,
    type SourceManga,
    type Tag,
    type TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";
import { AnimaceHelper } from "./utils";

// API response types
interface PopularItem {
    cover: string;
    title: string;
    permalink: string;
    manga_type: string;
}

interface LatestChapterEntry {
    manga_id: string;
    title: string;
    permalink: string;
    manga_permalink: string;
    cover: string;
    chapter: string;
    time: string;
    manga_type: string;
    manga_status: string;
    last_3_chapters: {
        title: string;
        chapter: string;
        link: string;
        time: string;
        is_new: boolean;
    }[];
}

interface SearchResultEntry {
    id: string;
    title: string;
    slug: string;
    alt_titles: string[];
    authors: string[];
    permalink: string;
    thumbnail: string;
    description: string;
    type: string;
    status: string;
}

interface ChapterEntry {
    id: string;
    chapter: string;
    title: string;
    date: string;
    chapter_type: string;
    group_id: string | null;
    language: string;
    group_name: string | null;
    likes: string;
    url: string;
}

interface ChapterContentResponse {
    success: boolean;
    chapter_id: number;
    chapter_type: string;
    images: string[];
    total: number;
}

export class AnimaceParser {
    private domain: string;
    private helper: AnimaceHelper;

    constructor(domain: string) {
        this.domain = domain;
        this.helper = new AnimaceHelper(domain);
    }

    parsePopularItems(
        jsonStr: string,
        sectionType: DiscoverSectionType,
    ): PagedResults<DiscoverSectionItem> {
        const items: DiscoverSectionItem[] = [];

        const itemType: "prominentCarouselItem" | "simpleCarouselItem" =
            sectionType === DiscoverSectionType.prominentCarousel
                ? "prominentCarouselItem"
                : "simpleCarouselItem";

        let data: PopularItem[];
        try {
            data = JSON.parse(jsonStr) as PopularItem[];
        } catch {
            throw new Error("Failed to parse popular items JSON.");
        }

        for (const manga of data) {
            const mangaId = this.extractMangaSlug(manga.permalink);
            const title = manga.title;
            const imageUrl = this.helper.fixImageUrl(manga.cover);

            if (mangaId && title) {
                items.push({ mangaId, title, imageUrl, type: itemType });
            }
        }

        return { items, metadata: undefined };
    }

    parseLatestUpdates(jsonStr: string, page: number): PagedResults<DiscoverSectionItem> {
        const items: DiscoverSectionItem[] = [];

        let response: { success: boolean; data: LatestChapterEntry[] };
        try {
            response = JSON.parse(jsonStr) as typeof response;
        } catch {
            throw new Error("Failed to parse latest chapters JSON.");
        }

        if (!response.success || !response.data) {
            return { items: [] };
        }

        for (const entry of response.data) {
            const mangaId = this.extractMangaSlug(entry.manga_permalink);
            const title = entry.title;
            const imageUrl = this.helper.fixImageUrl(entry.cover);

            const latestChapter = entry.last_3_chapters[0];
            let chapterId = "";
            if (latestChapter) {
                chapterId = this.extractChapterId(latestChapter.link);
            }

            if (mangaId && title && chapterId) {
                items.push({
                    mangaId,
                    title,
                    chapterId,
                    subtitle: entry.chapter || undefined,
                    imageUrl,
                    type: "chapterUpdatesCarouselItem",
                });
            }
        }

        let metadata: number | undefined = undefined;
        if (items.length > 0 && page < 10) {
            metadata = page + 1;
        }

        return { items, metadata };
    }

    parseHighscoreItems(jsonStr: string): PagedResults<DiscoverSectionItem> {
        const items: DiscoverSectionItem[] = [];

        let data: PopularItem[];
        try {
            data = JSON.parse(jsonStr) as PopularItem[];
        } catch {
            throw new Error("Failed to parse highscore items JSON.");
        }

        for (const manga of data) {
            const mangaId = this.extractMangaSlug(manga.permalink);
            const title = manga.title;
            const imageUrl = this.helper.fixImageUrl(manga.cover);

            if (mangaId && title) {
                items.push({ mangaId, title, imageUrl, type: "simpleCarouselItem" });
            }
        }

        return { items, metadata: undefined };
    }

    parseSearchResults(jsonStr: string): PagedResults<SearchResultItem> {
        const results: SearchResultItem[] = [];

        let data: SearchResultEntry[];
        try {
            data = JSON.parse(jsonStr) as SearchResultEntry[];
        } catch {
            throw new Error("Failed to parse search results JSON.");
        }

        for (const entry of data) {
            const mangaId = entry.slug || this.extractMangaSlug(entry.permalink);
            const title = entry.title;
            const imageUrl = this.helper.fixImageUrl(entry.thumbnail);

            if (mangaId && title) {
                results.push({
                    mangaId,
                    title,
                    subtitle: entry.type || undefined,
                    imageUrl,
                });
            }
        }

        return { items: results };
    }

    parseMangaDetails(html: string, mangaId: string, contentRating: ContentRating): SourceManga {
        const $ = cheerio.load(html);

        // Extract title from h1
        const title = $("h1").first().text().trim() || mangaId;

        // Extract cover image from JSON-LD or meta
        let imageUrl = "";
        $('script[type="application/ld+json"]').each((_i, el) => {
            try {
                const ld = JSON.parse($(el).html() ?? "") as { "@type"?: string; image?: string };
                if (ld["@type"] === "ComicSeries" && ld.image) {
                    imageUrl = ld.image;
                }
            } catch {
                /* skip */
            }
        });
        if (!imageUrl) {
            imageUrl = $('img[alt^="Cover for"]').first().attr("src") ?? "";
        }
        imageUrl = this.helper.fixImageUrl(imageUrl);

        // Extract author from JSON-LD
        let author = "Unknown";
        $('script[type="application/ld+json"]').each((_i, el) => {
            try {
                const ld = JSON.parse($(el).html() ?? "") as {
                    "@type"?: string;
                    author?: { name?: string };
                };
                if (ld["@type"] === "ComicSeries" && ld.author?.name) {
                    author = ld.author.name;
                }
            } catch {
                /* skip */
            }
        });

        // Extract description
        let description = "No description available.";
        const descEl = $("#description-content-tab");
        if (descEl.length > 0) {
            const allText: string[] = [];
            descEl.find("p").each((_i, p) => {
                const text = $(p).text().trim();
                if (text.length > 0) allText.push(text);
            });
            if (allText.length > 0) {
                description = allText.join("\n");
            } else {
                const text = descEl.text().trim();
                if (text.length > 0) description = text;
            }
        }

        // Extract status from JSON-LD
        let status: "ONGOING" | "COMPLETED" | "UNKNOWN" = "UNKNOWN";
        $('script[type="application/ld+json"]').each((_i, el) => {
            try {
                const ld = JSON.parse($(el).html() ?? "") as { "@type"?: string; status?: string };
                if (ld["@type"] === "ComicSeries" && ld.status) {
                    const s = ld.status.toLowerCase();
                    if (s.includes("ongoing")) status = "ONGOING";
                    else if (s.includes("completed") || s.includes("complete")) status = "COMPLETED";
                }
            } catch {
                /* skip */
            }
        });

        // Extract tags from links to /tag/
        const tags: Tag[] = [];
        $('a[href*="/tag/"]').each((_i, el) => {
            const tagText = $(el).text().trim();
            if (tagText && tagText.length < 30) {
                tags.push({
                    id: tagText.toLowerCase().replace(/\s+/g, "-"),
                    title: tagText,
                });
            }
        });

        const tagSections: TagSection[] = [];
        if (tags.length > 0) {
            tagSections.push({ id: "genres", title: "Genres", tags });
        }

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: imageUrl,
                synopsis: description,
                author: author !== "Unknown" ? author : undefined,
                contentRating,
                status,
                tagGroups: tagSections,
            },
        };
    }

    extractMangaNumericId(html: string): string {
        const $ = cheerio.load(html);
        return $(".chapter-list[data-manga-id]").attr("data-manga-id") ?? "";
    }

    parseChapters(jsonStr: string, sourceManga: SourceManga): Chapter[] {
        const chapters: Chapter[] = [];

        let response: { success: boolean; chapters: ChapterEntry[]; total: number; has_more: boolean };
        try {
            response = JSON.parse(jsonStr) as typeof response;
        } catch {
            throw new Error("Failed to parse chapters JSON.");
        }

        if (!response.success || !response.chapters) {
            return [];
        }

        for (const entry of response.chapters) {
            const chapterId = entry.id;
            const chapNum = parseFloat(entry.chapter) || 0;
            const chapterTitle = entry.title && entry.title !== "N/A" ? entry.title.trim() : undefined;
            const publishDate = this.parseRelativeDate(entry.date);

            chapters.push({
                chapterId,
                sourceManga,
                langCode: entry.language?.toUpperCase() || "EN",
                chapNum,
                title: chapterTitle,
                volume: undefined,
                publishDate,
            });
        }

        return chapters;
    }

    parseChapterDetails(jsonStr: string, chapterId: string, mangaId: string): ChapterDetails {
        let response: ChapterContentResponse;
        try {
            response = JSON.parse(jsonStr) as ChapterContentResponse;
        } catch {
            throw new Error("Failed to parse chapter content JSON.");
        }

        if (!response.success || !response.images || response.images.length === 0) {
            throw new Error(`No images found for chapter ${chapterId}.`);
        }

        const pages = response.images.map((url) => this.helper.fixImageUrl(url));

        return {
            id: chapterId,
            mangaId: mangaId,
            pages: pages,
        };
    }

    parseRelativeDate(dateText: string): Date {
        const now = new Date();
        const lowerText = dateText.toLowerCase();

        if (
            lowerText.includes("just now") ||
            lowerText.includes("now") ||
            lowerText.includes("second")
        ) {
            return now;
        }

        const minutesMatch = lowerText.match(/(\d+)\s*min/);
        if (minutesMatch?.[1]) {
            return new Date(now.getTime() - parseInt(minutesMatch[1]) * 60 * 1000);
        }

        const hoursMatch = lowerText.match(/(\d+)\s*hour/);
        if (hoursMatch?.[1]) {
            return new Date(now.getTime() - parseInt(hoursMatch[1]) * 60 * 60 * 1000);
        }

        const daysMatch = lowerText.match(/(\d+)\s*day/);
        if (daysMatch?.[1]) {
            return new Date(now.getTime() - parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000);
        }

        const weeksMatch = lowerText.match(/(\d+)\s*week/);
        if (weeksMatch?.[1]) {
            return new Date(now.getTime() - parseInt(weeksMatch[1]) * 7 * 24 * 60 * 60 * 1000);
        }

        const monthsMatch = lowerText.match(/(\d+)\s*month/);
        if (monthsMatch?.[1]) {
            return new Date(now.getTime() - parseInt(monthsMatch[1]) * 30 * 24 * 60 * 60 * 1000);
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
        if (dateMatch?.[1] && dateMatch[2] && dateMatch[3]) {
            const month = monthNames.findIndex((m) => dateMatch[1]!.startsWith(m));
            if (month !== -1) {
                return new Date(parseInt(dateMatch[3]), month, parseInt(dateMatch[2]));
            }
        }

        return now;
    }

    private extractMangaSlug(url: string): string {
        if (!url || !url.includes("/manga/")) return "";
        return url.split("/manga/")[1]?.replace(/\/$/, "") ?? "";
    }

    private extractChapterId(url: string): string {
        // URL format: /read/{slug}/ch{number}-{id}
        const match = url.match(/\/ch[\d.]+-(\d+)/);
        return match?.[1] ?? "";
    }
}
