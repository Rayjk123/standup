import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { sharePageFromPath } from "@standup/shared";
import App from "./App";
import { OwnerSignInNotice } from "./components/OwnerSignInNotice";
import { SharedReviewPage } from "./components/review/SharedReviewPage";
import { SharedDocPage } from "./components/docs/SharedDocPage";
import { SharedFolderPage } from "./components/docs/SharedFolderPage";
import { watchOwnerDenials } from "./lib/ownerSignIn";
import { ensureThemeTokens } from "./components/theme";
import { initTheme } from "./hooks/useTheme";

ensureThemeTokens();
initTheme();

const root = ReactDOM.createRoot(document.getElementById("root")!);

// A share link opens its read-only page alone: none of the console (its
// router, sign-in prompts or live socket) is mounted around it.
const sharePage = sharePageFromPath(window.location.pathname);
if (sharePage) {
  root.render(
    <React.StrictMode>
      {sharePage.type === "doc" ? (
        <SharedDocPage token={sharePage.token} />
      ) : sharePage.type === "folder" ? (
        <SharedFolderPage token={sharePage.token} />
      ) : (
        <SharedReviewPage token={sharePage.token} />
      )}
    </React.StrictMode>
  );
} else {
  watchOwnerDenials();
  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <OwnerSignInNotice />
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}
