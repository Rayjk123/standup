import mermaid from "mermaid";

/*
 * The script of mermaid-frame.html, the page Mermaid draws in. The console
 * loads that page in a hidden frame the first time a doc has a diagram and
 * calls Mermaid here through it (see lib/mermaid.ts); the page's policy keeps
 * anything a diagram names from loading.
 */
(window as Window & { standupMermaid?: typeof mermaid }).standupMermaid = mermaid;
