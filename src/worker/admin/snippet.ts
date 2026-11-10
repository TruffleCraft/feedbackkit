/** The script tag a site embeds, and the page that tests it, for a project's public key. */
export function embedSnippet(origin: string, widgetVersion: string | undefined, publicKey: string): { snippet: string; testPage: string } {
  return {
    snippet: `<script src="${origin}/widget.js?v=${widgetVersion ?? "unversioned"}" data-project="${publicKey}"></script>`,
    testPage: `${origin}/t/${publicKey}`,
  };
}
