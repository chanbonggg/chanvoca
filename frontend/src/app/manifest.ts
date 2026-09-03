import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ChanVoca",
    short_name: "ChanVoca",
    description: "매일 누적해서 복습하는 개인 영단어 암기장",
    start_url: "/",
    display: "standalone",
    background_color: "#080b12",
    theme_color: "#080b12",
    orientation: "portrait",
    lang: "ko",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}

