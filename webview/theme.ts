export const LAYER_COLORS: Record<string, string> = {
  route: "#4f8cff",
  ui: "#d86fa8",
  worker: "#f0734f",
  service: "#9b7bf4",
  repository: "#2db98c",
  model: "#e3a932",
  core: "#7f9bb8",
  util: "#8c8f9c",
  other: "#7b8794",
  test: "#6b7480",
  infra: "#1fb6cc",
};

// Teintes moyennes : lisibles sur thème clair comme sur thème sombre.
export const EDGE_COLORS = {
  call: "#7d869a",
  ref: "#7d869a",
  async: "#f0734f",
  uses: "#1fb6cc",
  consume: "#f0734f",
  broker: "#a78bfa",
  depends: "#7d869a",
  runs: "#7d869a",
  relation: "#e3a932",
  http: "#8b6cf0",
  danger: "#ee5350",
};

export function layerColor(layer: string): string {
  return LAYER_COLORS[layer] ?? LAYER_COLORS.other;
}

export function shortModule(name: string): string {
  const sep = name.includes("/") ? "/" : ".";
  const p = name.split(sep);
  return p.length > 2 ? p.slice(-2).join(sep) : name;
}
