// Add, remove, or edit sources here. Any RSS or Atom feed works.
export const FEEDS = [
  { name: 'Smashing Magazine', url: 'https://www.smashingmagazine.com/feed/' },
  { name: 'Nielsen Norman Group', url: 'https://www.nngroup.com/feed/rss/' },
  { name: 'A List Apart', url: 'https://alistapart.com/main/feed/' },
  { name: 'UX Collective', url: 'https://uxdesign.cc/feed' },
  { name: 'UX Planet', url: 'https://uxplanet.org/feed' },
  { name: 'Figma Blog', url: 'https://www.figma.com/blog/feed/atom.xml' },
  { name: 'Google Design', url: 'https://medium.com/feed/google-design' },
  { name: 'Creative Bloq', url: 'https://www.creativebloq.com/feeds/all' },
  { name: 'Creative Boom', url: 'https://www.creativeboom.com/feed/' },
  { name: 'Dezeen', url: 'https://www.dezeen.com/feed/' },
  { name: 'designboom', url: 'https://www.designboom.com/feed/' },
  { name: 'Sidebar', url: 'https://sidebar.io/feed.xml' },
  { name: 'CSS-Tricks', url: 'https://css-tricks.com/feed/' },
  { name: 'Abduzeedo', url: 'https://abduzeedo.com/rss.xml' },
  { name: 'Fast Company Design', url: 'https://www.fastcompany.com/co-design/rss' },
  { name: 'Typographica', url: 'https://typographica.org/feed/' },
  { name: 'Awwwards', url: 'https://www.awwwards.com/blog/feed/' },
  { name: 'Web Designer Depot', url: 'https://www.webdesignerdepot.com/feed/' },
  { name: 'Design Week', url: 'https://www.designweek.co.uk/feed/' },
];

// Each keyword is a string (weight 1) or { term, weight }. Broad words get 0.5 so they
// can't decide a category on their own. Title matches count 3x, feed tags 2x, summary 1x.
// The highest score wins; weak (< 2) or tied scores fall back to General.
export const CATEGORIES = [
  { name: 'AI & Emerging Tech', keywords: ['ai', 'artificial intelligence', 'machine learning', 'llm', 'generative', 'chatgpt', 'copilot', { term: 'agent', weight: 0.5 }, { term: 'agents', weight: 0.5 }, 'midjourney', 'gpt', { term: 'spatial', weight: 0.5 }, 'vision pro', { term: 'ar', weight: 0.5 }, { term: 'vr', weight: 0.5 }] },
  { name: 'Accessibility', keywords: ['accessibility', 'accessible', 'a11y', 'wcag', 'screen reader', { term: 'inclusive', weight: 0.5 }, { term: 'contrast', weight: 0.5 }, 'aria'] },
  { name: 'Design Systems', keywords: ['design system', 'design systems', 'design tokens', { term: 'tokens', weight: 0.5 }, 'component library', { term: 'components', weight: 0.5 }, 'storybook'] },
  { name: 'UX & Research', keywords: ['ux', 'user experience', 'usability', { term: 'research', weight: 0.5 }, 'user testing', { term: 'interview', weight: 0.5 }, 'persona', { term: 'journey', weight: 0.5 }, 'information architecture', { term: 'navigation', weight: 0.5 }, 'onboarding', 'heuristic', 'service design'] },
  { name: 'Typography', keywords: ['typography', 'typeface', 'font', 'fonts', 'type design', 'lettering', 'variable font', { term: 'serif', weight: 0.5 }, { term: 'sans', weight: 0.5 }, { term: 'type foundry', weight: 0.5 }, 'glyph'] },
  { name: 'Branding & Identity', keywords: ['redesign', 'uniform', 'jersey', 'merch', { term: 'kit', weight: 0.5 }, 'mascot', 'brand', 'branding', 'identity', 'logo', 'rebrand', 'visual identity', 'packaging', { term: 'campaign', weight: 0.5 }] },
  { name: 'Tools & Workflow', keywords: ['figma', 'sketch', 'adobe', 'photoshop', 'illustrator', 'framer', { term: 'plugin', weight: 0.5 }, { term: 'workflow', weight: 0.5 }, 'prototype', 'prototyping', { term: 'tool', weight: 0.5 }, { term: 'tools', weight: 0.5 }, 'handoff', 'dev mode'] },
  { name: 'Web & Frontend', keywords: ['css', 'html', 'javascript', 'web design', 'frontend', 'front-end', 'responsive', { term: 'layout', weight: 0.5 }, { term: 'grid', weight: 0.5 }, 'flexbox', 'svg', { term: 'browser', weight: 0.5 }, { term: 'performance', weight: 0.5 }, { term: 'website', weight: 0.5 }] },
  { name: 'Architecture & Interiors', keywords: ['interior design', 'hotel', 'restaurant', 'retail', 'store', 'bathroom', 'kitchen', 'renovation', { term: 'home', weight: 0.5 }, { term: 'studio space', weight: 0.5 }, 'architecture', 'architect', 'interior', 'interiors', { term: 'building', weight: 0.5 }, { term: 'house', weight: 0.5 }, 'pavilion', 'museum', 'furniture', { term: 'urban', weight: 0.5 }] },
  { name: 'Product & Industrial', keywords: ['camera', 'smart home', 'materials', 'sustainable', 'compostable', 'bioplastic', 'appliance', 'wearable', 'sneaker', 'product design', 'industrial design', { term: 'hardware', weight: 0.5 }, { term: 'device', weight: 0.5 }, { term: 'car', weight: 0.5 }, 'automotive', { term: 'gadget', weight: 0.5 }, { term: 'chair', weight: 0.5 }, { term: 'lamp', weight: 0.5 }, { term: 'object', weight: 0.5 }] },
  { name: 'Illustration & Art', keywords: ['magazine', 'editorial', 'zine', 'book cover', 'print', 'printmaking', 'mural', 'comic', 'illustration', { term: 'art', weight: 0.5 }, 'artist', 'painting', 'photography', 'animation', '3d', { term: 'exhibition', weight: 0.5 }, { term: 'poster', weight: 0.5 }, 'graphic design'] },
  { name: 'Career & Industry', keywords: [{ term: 'studio', weight: 0.5 }, 'founder', 'interview with', 'career', 'hiring', { term: 'job', weight: 0.5 }, 'jobs', 'portfolio', 'leadership', { term: 'team', weight: 0.5 }, 'agency', { term: 'business', weight: 0.5 }, 'layoffs', 'salary', { term: 'award', weight: 0.5 }, { term: 'awards', weight: 0.5 }] },
];

export const FALLBACK_CATEGORY = 'General';
