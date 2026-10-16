# independent-formatters

Implement four independent formatting helpers, one simple operation per module, with no cross-module dependencies. They share no imports or state.
src/count.mjs countLabel(count): require a nonnegative safe integer (RangeError otherwise); zero returns "No items", one returns "1 item", other values return "N items" with N replaced by count.
src/name.mjs displayName(first,last): require both arguments to be strings (TypeError otherwise), trim each, join nonempty parts with one space; if both are blank return "Anonymous".
src/status.mjs statusLabel(enabled): accept only booleans, true returns "Enabled", false returns "Disabled"; other values throw TypeError.
src/duration.mjs durationLabel(seconds): require a nonnegative safe integer (RangeError otherwise); return "M minutes S seconds", substituting whole minutes and remaining seconds, retaining those exact plural words even for 1. Example 61 returns "1 minutes 1 seconds".
Set config version to 2 preserving keep with a deterministic operation. Keep unrelated files unchanged.
