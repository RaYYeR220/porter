import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [...nextVitals, ...nextTs, { ignores: [".next/**", ".vercel/**", "node_modules/**", ".superpowers/**"] }];

export default config;
