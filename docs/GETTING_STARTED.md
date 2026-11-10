# From installation to your first report

Choose an installation first: [Linux / Proxmox LXC / Docker](SELF_HOSTING.md) or [Cloudflare](QUICKSTART.md). After the gateway is running, the project setup is the same.

## 1. Sign in

Open `https://<your-gateway>/admin`. Use your gateway's admin token, or Cloudflare Access if that deployment has it configured. Keep the admin token private; never put it in your website or widget snippet.

## 2. Create a project

Choose **New project**. Enter a permanent ID such as `example-website`, your website origin such as `https://example.org`, and the language for reports. The origin is the scheme and hostname, with an optional port; it is not a page URL.

The project starts with one Feedback type, AI off, and delivery to the FeedbackKit inbox. No external credentials are needed. Use a separate project for each website whose origins, types or destinations differ.

## 3. Install the widget

On the project's **Setup & snippet** tab, copy its script tag into your website before `</body>`:

```html
<script src="https://<your-gateway>/widget.js" data-project="fk_pub_…"></script>
```

Use the actual snippet from your project. Its public key identifies the project; it is not the admin token. The widget can be embedded in any website stack. Under a Content Security Policy, allow the gateway in the directives listed in [the CSP guide](QUICKSTART.md#4-embed-the-widget).

## 4. Check both the widget and delivery

Use the project's test page for a dry run without creating a ticket. Then open the widget on your actual website and send a neutral sample message. Check **Delivery log & inbox** for the result. Inbox reports stay in FeedbackKit; reports delivered to GitHub link to their destination. **Send test report** on the project page exercises the real configured destination and may create a GitHub issue or draft.

If the widget is missing or a request is rejected, check the exact website origin, the browser's Content Security Policy, and `/diag`. Do not add the admin token to a public request to make it work.

## 5. Configure your workflow

In **Settings**, edit origins, feedback types, required fields, AI settings, delivery, privacy and retention. **Review changes** validates the draft and shows a diff and its destinations. **Publish** saves it. Other gateway processes pick it up within 60 seconds.

For GitHub delivery, configure a gateway token environment variable first, then refer to its **name** in the destination settings. For AI, configure `LLM_API_KEY` and choose the provider/model. Never enter token values into project JSON or public snippets. See the [admin guide](ADMIN.md) for these settings and revision numbers.

Co-created by Michel with NORA (AI Agent)
