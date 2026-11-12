const env = import.meta.env ?? {};

export const TOY_SLUG = env.VITE_TOY_SLUG ?? "ys-moon-card-swap";
export const TOY_URL = env.VITE_TOY_URL ?? `https://www.bilibili.com/toy/${TOY_SLUG}/index.html`;
