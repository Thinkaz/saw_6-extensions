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
    type Tag,
    type TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import * as htmlparser2 from "htmlparser2";
import { MainInterceptor } from "./network";

const baseUrl = "https://www.natomanga.com";

type NatomangaImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding;

export class NatomangaExtension implements NatomangaImplementation {
    requestManager = new MainInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 15,
        bufferInterval: 10,
        ignoreImages: true,
    });

    async initialise(): Promise<void> {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
    }

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            {
                id: "popular_section",
                title: "Popular",
                type: DiscoverSectionType.featured,
            },
            {
                id: "latest_section",
                title: "Latest Releases",
                type: DiscoverSectionType.prominentCarousel,
            },
            {
                id: "more_manga_section",
                title: "More Manga",
                type: DiscoverSectionType.simpleCarousel,
            },
        ];
    }

    private async getGenresList(): Promise<{ id: string; value: string }[]> {
        try {
            const request = {
                url: `${baseUrl}`,
                method: "GET",
            };

            const $ = await this.fetchCheerio(request);
            const genres: { id: string; value: string }[] = [];

            // Assume genres are in a list like .genres li a or similar; adapt based on site
            // From summary, links like /genre/comedy
            // Static fallback if scraping fails
            const staticGenres = [
                { id: "action", value: "Action" },
                { id: "comedy", value: "Comedy" },
                { id: "drama", value: "Drama" },
                { id: "fantasy", value: "Fantasy" },
                { id: "horror", value: "Horror" },
                { id: "romance", value: "Romance" },
                // Add more as needed
            ];

            // Try scraping if possible; placeholder selector
            $(".genres li a, .genre-list a").each((_, element) => {
                const genre = $(element).text().trim();
                const href = $(element).attr("href") || "";
                const slug = href.split("/genre/").pop()?.split("/")[0] || "";

                if (
                    genre &&
                    slug &&
                    !slug.includes("status") &&
                    !slug.includes("top")
                ) {
                    genres.push({
                        id: slug,
                        value: genre,
                    });
                }
            });

            if (genres.length === 0) {
                return staticGenres;
            }

            return genres.sort((a, b) => a.value.localeCompare(b.value));
        } catch (error) {
            console.error("Failed to get genre list:", error);
            return [
                { id: "action", value: "Action" },
                { id: "comedy", value: "Comedy" },
            ];
        }
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: any | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        switch (section.id) {
            case "popular_section":
                return this.getPopularSectionItems(section, metadata);
            case "latest_section":
                return this.getLatestSectionItems(section, metadata);
            case "more_manga_section":
                return this.getMoreMangaSectionItems(section, metadata);
            default:
                return { items: [] };
        }
    }

    async getSearchFilters(): Promise<SearchFilter[]> {
        const genresList = await this.getGenresList();

        return [
            {
                id: "genres",
                type: "dropdown",
                options: genresList,
                value: "all",
                title: "Genre Filter",
            },
        ];
    }

    async getSearchResults(
        query: SearchQuery,
        metadata?: any,
    ): Promise<PagedResults<SearchResultItem>> {
        const page = metadata?.page ?? 1;
        let searchUrl = `${baseUrl}/search/story/${encodeURIComponent(query.title)}`;

        const genreFilter = query.filters.find(
            (filter) => filter.id === "genres",
        )?.value as string;
        if (genreFilter && genreFilter !== "all") {
            searchUrl = `${baseUrl}/genre/${genreFilter}`;
        }

        const request = { url: searchUrl, method: "GET" };

        const $ = await this.fetchCheerio(request);
        const items: SearchResultItem[] = [];

        $(".doreamon .itemupdate.first").each((_, element) => {
            const item = $(element);
            const link = item.find("a.cover");
            const title = item.find("h3 a").first().text().trim();
            let imageUrl =
                item.find("img").attr("src") ||
                item.find("img").attr("data-src") ||
                "";
            if (!imageUrl.startsWith("http"))
                imageUrl = `${baseUrl}${imageUrl}`;
            const mangaId =
                link
                    .attr("href")
                    ?.split("/manga/")[1]
                    ?.split("?")[0]
                    ?.split("/")[0] || "";
            const subtitle = item.find("li a").first().text().trim();

            if (title && mangaId && !mangaId.includes("toffee.ai")) {
                items.push({
                    mangaId,
                    title,
                    subtitle: subtitle || undefined,
                    imageUrl,
                });
            }
        });

        // No pagination for minimal
        return { items };
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request = {
            url: `${baseUrl}/manga/${mangaId}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);

        const title = $(".story-info-right h1").text().trim() || mangaId;
        let imageUrl = $(".info-image img").attr("src") || "";
        if (!imageUrl.startsWith("http")) imageUrl = `${baseUrl}${imageUrl}`;
        const description = $(".panel-story-info-description").text().trim();

        let status = "UNKNOWN";
        const statusText =
            $(".variations-tableInfo tr")
                .eq(1)
                ?.find(".table-value")
                .text()
                .trim()
                .toLowerCase() || "";
        if (statusText.includes("ongoing")) status = "ONGOING";
        else if (statusText.includes("completed")) status = "COMPLETED";

        const author =
            $(".variations-tableInfo .table-value").first().text().trim() ||
            undefined;

        const genres: Tag[] = [];
        $(".variations-tableInfo .table-value a.a-h").each((_, element) => {
            const genre = $(element).text().trim();
            if (genre) {
                genres.push({
                    id: genre.toLowerCase().replace(/\s+/g, "-"),
                    title: genre,
                });
            }
        });

        const tagSections: TagSection[] =
            genres.length > 0
                ? [
                      {
                          id: "genres",
                          title: "Genres",
                          tags: genres,
                      },
                  ]
                : [];

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: imageUrl,
                synopsis: description || "No synopsis available.",
                contentRating: ContentRating.EVERYONE,
                status,
                author,
                tagGroups: tagSections,
            },
        };
    }

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const request = {
            url: `${baseUrl}/manga/${sourceManga.mangaId}`,
            method: "GET",
        };

        const $ = await this.fetchCheerio(request);
        const chapters: Chapter[] = [];

        $(".row-content-chapter li").each((_, element) => {
            const li = $(element);
            const link = li.find("a");
            const chapterHref = link.attr("href") || "";
            const chapterTitle = link.text().trim();

            const chapterMatch =
                chapterHref.match(/chapter-(\d+(?:\.\d+)?)/i) ||
                chapterTitle.match(/chapter\s+(\d+(?:\.\d+)?)/i);
            const chapNum = chapterMatch
                ? parseFloat(chapterMatch[1])
                : chapters.length + 1;
            const chapterId = chapterMatch
                ? chapterMatch[1]
                : `${chapters.length}`;

            if (chapterId && !chapterHref.includes("toffee.ai")) {
                chapters.push({
                    chapterId,
                    title: chapterTitle,
                    sourceManga,
                    chapNum,
                    langCode: "EN",
                    volume: undefined,
                });
            }
        });

        return chapters.sort((a, b) => b.chapNum - a.chapNum);
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const chapterUrl = `${baseUrl}/manga/${chapter.sourceManga.mangaId}/chapter-${chapter.chapterId}`;
        const request: Request = { url: chapterUrl, method: "GET" };

        const $ = await this.fetchCheerio(request);
        const pages: string[] = [];

        $(".container-chapter-reader img").each((_, element) => {
            let imgUrl =
                $(element).attr("src") || $(element).attr("data-src") || "";
            if (imgUrl && !imgUrl.startsWith("http"))
                imgUrl = `${baseUrl}${imgUrl}`;
            if (imgUrl) pages.push(imgUrl);
        });

        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            pages,
        };
    }

    // Separate discover methods like Mangabuddy
    async getPopularSectionItems(
        section: DiscoverSection,
        metadata: any | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const request = { url: baseUrl, method: "GET" };
        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        $(".slide .owl-item .item").each((_, element) => {
            const unit = $(element);
            const link = unit.find("a");
            const title = unit.find(".slide-caption h3 a").text().trim();
            let imageUrl = unit.find("img").attr("src") || "";
            if (!imageUrl.startsWith("http"))
                imageUrl = `${baseUrl}${imageUrl}`;
            const mangaId =
                link
                    .attr("href")
                    ?.split("/manga/")[1]
                    ?.split("?")[0]
                    ?.split("/")[0] || "";
            const subtitle = unit
                .find(".slide-caption a[href*='/chapter']")
                .text()
                .trim();

            if (title && mangaId && !mangaId.includes("toffee.ai")) {
                items.push({
                    type: "featuredCarouselItem",
                    mangaId,
                    imageUrl,
                    title,
                    subtitle: subtitle || undefined,
                });
            }
        });

        return { items };
    }

    async getLatestSectionItems(
        section: DiscoverSection,
        metadata: any | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const request = { url: baseUrl, method: "GET" };
        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        $(".doreamon .itemupdate.first")
            .slice(0, 10)
            .each((_, element) => {
                const unit = $(element);
                const link = unit.find("a.cover");
                const title = unit.find("h3 a").first().text().trim();
                let imageUrl =
                    unit.find("img").attr("src") ||
                    unit.find("img").attr("data-src") ||
                    "";
                if (!imageUrl.startsWith("http"))
                    imageUrl = `${baseUrl}${imageUrl}`;
                const mangaId =
                    link
                        .attr("href")
                        ?.split("/manga/")[1]
                        ?.split("?")[0]
                        ?.split("/")[0] || "";
                const subtitle = unit.find("li a").first().text().trim();

                if (title && mangaId && !mangaId.includes("toffee.ai")) {
                    items.push({
                        type: "prominentCarouselItem",
                        mangaId,
                        imageUrl,
                        title,
                        subtitle: subtitle || undefined,
                    });
                }
            });

        return { items };
    }

    async getMoreMangaSectionItems(
        section: DiscoverSection,
        metadata: any | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const request = { url: baseUrl, method: "GET" };
        const $ = await this.fetchCheerio(request);
        const items: DiscoverSectionItem[] = [];

        $(".doreamon .itemupdate.first")
            .slice(10, 20)
            .each((_, element) => {
                const unit = $(element);
                const link = unit.find("a.cover");
                const title = unit.find("h3 a").first().text().trim();
                let imageUrl =
                    unit.find("img").attr("src") ||
                    unit.find("img").attr("data-src") ||
                    "";
                if (!imageUrl.startsWith("http"))
                    imageUrl = `${baseUrl}${imageUrl}`;
                const mangaId =
                    link
                        .attr("href")
                        ?.split("/manga/")[1]
                        ?.split("?")[0]
                        ?.split("/")[0] || "";
                const subtitle = unit.find("li a").first().text().trim();

                if (title && mangaId && !mangaId.includes("toffee.ai")) {
                    items.push({
                        type: "simpleCarouselItem",
                        mangaId,
                        imageUrl,
                        title,
                        subtitle: subtitle || undefined,
                    });
                }
            });

        return { items };
    }

    async fetchCheerio(request: Request): Promise<CheerioAPI> {
        const [response, data] = await Application.scheduleRequest(request);
        if (response.status !== 200) {
            throw new Error(
                `HTTP ${response.status}: Failed to fetch ${request.url}`,
            );
        }
        const htmlStr = Application.arrayBufferToUTF8String(data);
        const dom = htmlparser2.parseDocument(htmlStr);
        return cheerio.load(dom);
    }
}

export const Natomanga = new NatomangaExtension();
