// Génère media/icon.png (128 + 256) et media/banner.png à partir de media/logo.svg.
// Usage : node scripts/make-assets.mjs   (nécessite @resvg/resvg-js)
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const logo = readFileSync("media/logo.svg", "utf8");
const render = (svg, width, opts = {}) => new Resvg(svg, { fitTo: { mode: "width", value: width }, ...opts }).render().asPng();

writeFileSync("media/icon.png", render(logo, 256));
writeFileSync("media/icon-128.png", render(logo, 128));

const fonts = ["/usr/share/fonts/truetype/google-fonts/Poppins-SemiBold.ttf", "/usr/share/fonts/truetype/google-fonts/Poppins-Regular.ttf"].filter(existsSync);
const inner = logo.replace(/<svg[^>]*>/, "").replace("</svg>", "");
const banner = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640">
  <defs>
    <linearGradient id="bgb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14183a"/><stop offset="1" stop-color="#090b1c"/></linearGradient>
    <radialGradient id="gl" cx="0.15" cy="0.2" r="0.8"><stop offset="0" stop-color="#4f8cff" stop-opacity="0.25"/><stop offset="1" stop-color="#4f8cff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1280" height="640" fill="url(#bgb)"/>
  <rect width="1280" height="640" fill="url(#gl)"/>
  <g fill="none" stroke="#fff" stroke-opacity="0.045" stroke-width="2">
    <path d="M700 520 C640 380 760 220 960 200 C1160 180 1300 300 1250 430 C1200 560 1000 640 860 600 C780 580 720 560 700 520 Z"/>
    <path d="M760 500 C710 400 800 280 960 262 C1110 246 1220 330 1182 428 C1144 520 1000 580 890 552 C820 534 776 520 760 500 Z"/>
    <path d="M830 480 C800 410 860 330 966 318 C1066 306 1138 360 1112 424 C1088 484 1000 520 928 504 C880 494 842 488 830 480 Z"/>
  </g>
  <g transform="translate(110 150) scale(1.35)">${inner}</g>
  <text x="520" y="290" font-family="Poppins" font-weight="600" font-size="96" fill="#ffffff">Cartograph</text>
  <text x="522" y="352" font-family="Poppins" font-size="33" fill="#b8c0e0">See how your code really works.</text>
  <text x="522" y="398" font-family="Poppins" font-size="33" fill="#b8c0e0">Calls, architecture, workers, databases.</text>
  <g font-family="Poppins" font-size="24" fill="#7f8aba">
    <text x="522" y="470">Python · TypeScript · Go · Java · Kotlin · PHP · Dart · Rust</text>
  </g>
</svg>`;
writeFileSync("media/banner.svg", banner);
writeFileSync("media/banner.png", render(banner, 1280, { font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: "Poppins" } }));
console.log("assets générés :", fonts.length ? "police Poppins" : "police par défaut");
