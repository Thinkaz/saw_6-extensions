import {
    ContentRating,
    SourceIntents,
    type ExtensionInfo,
} from "@paperback/types";

export default {
    name: "AsuraScans",
    description: "Extension for AsuraScans - Read manga and manhwa online",
    version: "1.0.0-alpha.1",
    icon: "icon.png",
    language: "en",
    contentRating: ContentRating.MATURE,
    capabilities:
        SourceIntents.SETTINGS_FORM_PROVIDING |
        SourceIntents.DISCOVER_SECIONS_PROVIDING |
        SourceIntents.SEARCH_RESULTS_PROVIDING |
        SourceIntents.CHAPTER_PROVIDING |
        SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    badges: [],
    developers: [
        {
            name: "Saw_6",
        },
    ],
} satisfies ExtensionInfo;
