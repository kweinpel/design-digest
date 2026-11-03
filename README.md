# Design Digest

A personal design-news reader that runs on your Mac. It pulls articles from about 20 design publications, sorts them into categories, and learns from your likes and dislikes.

## Run it

```bash
cd ~/design-digest
npm start
```

Open http://localhost:4321. It needs Node 20 or later and has no dependencies.

Feeds refresh when the server starts, every hour while it runs, and whenever you click **Refresh**.

## Features

- **Daily, Weekly, Monthly, All** switch the time period.
- **Categories:** articles are auto-tagged by keyword. Edit the rules in `feeds.js`.
- **Search:** press `/` to focus the search box. Search covers titles, summaries, sources, and tags.
- **Feedback:**
  - 👍 means "more like this" and 👎 means "less like this" (the article is also hidden).
  - "For you" ranks articles by how well they match the categories, sources, and keywords you liked, weighted by recency.
  - **Top picks** shows your strongest matches.
  - The sidebar shows what the app has learned about your interests.
- **Saved:** bookmark articles to read later.
- **Hide read:** clicked articles are dimmed, and you can hide them.
- **Sources:** turn individual publications off in the sidebar.

## Customize

- **Add your own sites in `sources.txt`.** Put one website per line, with an optional name after `|`. You can use a homepage or a feed URL; the app finds the RSS/Atom feed automatically. New sites appear after the next Refresh, marked ★ in the sidebar's Sources list. Sites without a feed are marked "no feed".
- To change the built-in feeds, edit `FEEDS` in `feeds.js`.
- Adjust category keyword lists in `CATEGORIES`. Matches in the title count most, then feed tags, then the summary. Use `{ term: 'word', weight: 0.5 }` for broad words. Articles that match nothing go to **General**.
- Articles without a reliable date are labeled "found Xd ago", based on when the app first saw them.
- Likes and dislikes gradually lose weight over about two months, so your recent taste counts most.

## Data

Everything stays local in `data/`:

- `articles.json` holds 120 days of history.
- `feedback.json` holds your likes, dislikes, and saved articles.
- `discovered.json` caches the feeds found for `sources.txt` sites. The app checks them again every 30 days, or sooner if a feed keeps failing.

The server only listens on your Mac (127.0.0.1). It rejects requests from other websites, so a page you visit can't change your feedback or open links.
