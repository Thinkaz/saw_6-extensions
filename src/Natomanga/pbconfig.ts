import {
    ContentRating,
    SourceIntents,
    type ExtensionInfo,
} from "@paperback/types";

export default {
    name: "Natomanga",
    description:
        "Template that shows the functionality of content providing extensions.",
    version: "1.0.0-alpha.9",
    icon: "icon.png",
    language: "en",
    contentRating: ContentRating.EVERYONE,
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
