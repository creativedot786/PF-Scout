# PF Scout

A design assessment for Property Finder: **Scout**, a conversational property search for renting in Dubai.

**Try it:** https://scout-prototype-omega.vercel.app (best on a phone)

## What it does

You tell Scout what you're looking for in your own words. It keeps a short, visible memory of what it understood, marks what it guessed, and shows listings that match only that. Tap the memory to correct it, or just say so. When nothing fits, Scout tells you which one requirement is blocking and offers to drop it.

The design thinking is in [design.md](design.md).

## Why a browser, not an app

It's designed as a native mobile app. It's built as a web app so it can be opened from a link without TestFlight or installs. On a phone it runs full-screen; on a desktop it's shown inside a phone frame.

## Run it yourself

```
npm install
npx vercel dev
```

Add an `ANTHROPIC_API_KEY` to the environment. Listings are seeded sample data; photos are Unsplash placeholders.

