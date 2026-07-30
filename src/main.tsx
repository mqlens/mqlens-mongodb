// The system webview (WKWebView / WebView2 / WebKitGTK) has no Node `Buffer`,
// which @mongodb-js/shell-bson-parser needs to parse UUID(…) / BinData(…) in the
// query bar. Provide it before anything that might parse a query loads.
import { Buffer } from "buffer";
if (typeof (globalThis as { Buffer?: unknown }).Buffer === "undefined") {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { ThemeProvider } from "./components/theme/ThemeProvider";
import { TooltipProvider } from "./components/ui/tooltip";
import { I18nProvider } from "./components/i18n/I18nProvider";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>,
);
