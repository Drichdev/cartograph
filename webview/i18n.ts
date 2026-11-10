import { createContext, useContext } from "react";
import { M } from "./messages";
import type { Issue } from "./types";

export type Lang = "fr" | "en";
export type TFn = (key: string, p?: Record<string, string | number | undefined>) => string;

/** Traduction avec paramètres {nom} et pluriels {n|singulier|pluriel}. */
export function makeT(lang: Lang): TFn {
  const idx = lang === "fr" ? 0 : 1;
  return (key, p) => {
    const entry = M[key];
    let s = entry ? entry[idx] : key.split(".").pop()!;
    if (p) {
      s = s.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (_: string, name: string, one: string, many: string) => {
        const n = Number(p[name]);
        const singular = lang === "fr" ? n >= 0 && n < 2 : n === 1;
        return singular ? one : many;
      });
      s = s.replace(/\{(\w+)\}/g, (_: string, k: string) => (p[k] === undefined ? "" : String(p[k])));
    }
    return s;
  };
}

export const LangContext = createContext<{ lang: Lang; t: TFn }>({ lang: "fr", t: makeT("fr") });
export const useT = () => useContext(LangContext);

/** Message d'un problème détecté : traduit d'après la règle et ses paramètres, sinon texte brut (diagnostics VS Code). */
export function issueMessage(t: TFn, i: Issue): string {
  const why = i.params?.why;
  const key = "issue." + i.rule + (why ? "." + why : "");
  if (i.source === "cartograph" && M[key]) return t(key, i.params ?? {});
  return i.message;
}
