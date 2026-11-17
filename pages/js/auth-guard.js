
/* =====================================================
   FILA GRADES SYSTEM — PAGE AUTHENTICATION GUARD
===================================================== */

(function () {

    "use strict";

    const LOGIN_PAGE = "/index.html";

    const VERIFY_PAGE = "/pages/sector/verify-email.html";

    const PASSWORD_PAGE = "/pages/sector/set-password.html";

    let checking = false;

    function redirectTo(url) {
        window.location.replace(url);
    }

    function showAccessMessage(message) {

        document.body.innerHTML = "";

        const container = document.createElement("div");

        container.style.cssText = `
            min-height:100vh;
            display:flex;
            align-items:center;
            justify-content:center;
            padding:25px;
            font-family:Arial,sans-serif;
            background:#f1f5f9;
            text-align:center;
        `;

        const content = document.createElement("div");

        content.style.cssText = `
            max-width:420px;
            background:white;
            padding:30px;
            border-radius:14px;
            box-shadow:0 8px 30px rgba(0,0,0,.08);
        `;

        const heading = document.createElement("h2");
        heading.textContent = "Access Restricted";
        heading.style.color = "#123b67";

        const paragraph = document.createElement("p");
        paragraph.textContent = message;
        paragraph.style.lineHeight = "1.7";
        paragraph.style.color = "#64748b";

        content.appendChild(heading);
        content.appendChild(paragraph);
        container.appendChild(content);

        document.body.appendChild(container);
    }

    async function protectPage(options = {}) {

        if (checking) return;

        checking = true;

        const allowedRoles = options.roles || [
            "owner",
            "sector_admin",
            "school_admin",
            "teacher"
        ];

        document.documentElement.style.visibility = "hidden";

        try {

            const response = await fetch(
                "/api/auth/session",
                {
                    method: "GET",
                    credentials: "same-origin",
                    cache: "no-store"
                }
            );

            const result = await response.json();

            if (!response.ok || !result.success) {

                if (
                    result.code === "EMAIL_NOT_VERIFIED"
                ) {
                    redirectTo(VERIFY_PAGE);
                    return;
                }

                if (
                    result.code === "PASSWORD_CHANGE_REQUIRED"
                ) {
                    redirectTo(PASSWORD_PAGE);
                    return;
                }

                redirectTo(LOGIN_PAGE);
                return;
            }

            const user = result.user;

            if (
                !user ||
                !allowedRoles.includes(user.role)
            ) {
                showAccessMessage(
                    "You are not authorized to access this page."
                );

                document.documentElement.style.visibility = "visible";
                return;
            }

            window.currentUser = user;

            document.documentElement.style.visibility = "visible";

            document.dispatchEvent(
                new CustomEvent("fila-auth-ready", {
                    detail: user
                })
            );

        } catch (error) {

            console.error("Page authentication error:", error);

            showAccessMessage(
                "Unable to verify your session. Please check your internet connection and try again."
            );

            document.documentElement.style.visibility = "visible";

        } finally {

            checking = false;

        }
    }

    window.protectPage = protectPage;

    window.addEventListener("pageshow", function () {

        const pageOptions = window.FILA_PAGE_AUTH || {};

        protectPage(pageOptions);

    });

})();
