
/* =====================================================
   FILA GRADES SYSTEM
   SCHOOL ADMIN RESPONSIVE SIDEBAR
===================================================== */

(function () {
    "use strict";

    const currentUser = JSON.parse(
        localStorage.getItem("currentUser") || "{}"
    );

    const userName = currentUser.full_name || "School Administrator";

    const firstLetter = userName.trim().charAt(0).toUpperCase() || "S";

    const sidebarHTML = `
        <aside class="school-sidebar" id="schoolSidebar">

            <div class="sidebar-brand">
                <div class="sidebar-brand-icon">🎓</div>

                <div class="sidebar-brand-text">
                    <h2>Fila Grades</h2>
                    <p>School Administration</p>
                </div>
            </div>

            <nav class="sidebar-navigation">

                <div class="sidebar-section-title">
                    Main Menu
                </div>

                <a href="dashboard.html" class="sidebar-link">
                    <span class="sidebar-link-icon">🏠</span>
                    <span>Dashboard</span>
                </a>

                <a href="users.html" class="sidebar-link">
                    <span class="sidebar-link-icon">👥</span>
                    <span>School Users</span>
                </a>

                <a href="add-teacher.html" class="sidebar-link">
                    <span class="sidebar-link-icon">👨‍🏫</span>
                    <span>Add Teacher</span>
                </a>

                <a href="add-student.html" class="sidebar-link">
                    <span class="sidebar-link-icon">🎓</span>
                    <span>Manage Students</span>
                </a>

                <div class="sidebar-section-title">
                    Academic Management
                </div>

                <a href="../admin/tests.html" class="sidebar-link">
                    <span class="sidebar-link-icon">📝</span>
                    <span>Manage Tests</span>
                </a>

                <a href="school-marks.html" class="sidebar-link">
                    <span class="sidebar-link-icon">📊</span>
                    <span>School Marks</span>
                </a>

                <a href="inspect-marks-recording.html" class="sidebar-link">
                    <span class="sidebar-link-icon">🔍</span>
                    <span>Inspect Marks Recording</span>
                </a>

            </nav>

            <div class="sidebar-footer">

                <div class="sidebar-user">
                    <div class="sidebar-user-avatar">
                        ${firstLetter}
                    </div>

                    <div class="sidebar-user-info">
                        <strong>${escapeHTML(userName)}</strong>
                        <span>School Administrator</span>
                    </div>
                </div>

                <button class="sidebar-logout" id="sidebarLogout">
                    <span class="sidebar-link-icon">↪</span>
                    <span>Logout</span>
                </button>

            </div>

        </aside>

        <div class="sidebar-overlay" id="sidebarOverlay"></div>

        <header class="sidebar-mobile-header">
            <button
                class="sidebar-menu-button"
                id="sidebarMenuButton"
                type="button"
                aria-label="Open navigation menu"
                aria-expanded="false"
            >
                ☰
            </button>

            <span class="sidebar-mobile-title">
                Fila Grades System
            </span>
        </header>
    `;

    function escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, function (char) {
            const entities = {
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;"
            };

            return entities[char];
        });
    }

    function initializeSidebar() {
        const container = document.getElementById("schoolSidebarContainer");

        if (!container) {
            console.error(
                "School sidebar container not found. Add #schoolSidebarContainer to the page."
            );
            return;
        }

        container.innerHTML = sidebarHTML;

        const sidebar = document.getElementById("schoolSidebar");
        const overlay = document.getElementById("sidebarOverlay");
        const menuButton = document.getElementById("sidebarMenuButton");
        const logoutButton = document.getElementById("sidebarLogout");

       
/* ACTIVE PAGE DETECTION */

const currentPath = window.location.pathname
    .replace(/\/+$/, "")
    .toLowerCase();

sidebar.querySelectorAll(".sidebar-link").forEach(link => {

    const linkUrl = new URL(link.getAttribute("href"), window.location.href);

    const linkPath = linkUrl.pathname
        .replace(/\/+$/, "")
        .toLowerCase();

    if (currentPath === linkPath) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
    }

});

        /* OPEN SIDEBAR */

        function openSidebar() {
            sidebar.classList.add("open");
            overlay.classList.add("visible");
            menuButton.setAttribute("aria-expanded", "true");
        }

        /* CLOSE SIDEBAR */

        function closeSidebar() {
            sidebar.classList.remove("open");
            overlay.classList.remove("visible");
            menuButton.setAttribute("aria-expanded", "false");
        }

        menuButton.addEventListener("click", function () {
            if (sidebar.classList.contains("open")) {
                closeSidebar();
            } else {
                openSidebar();
            }
        });

        overlay.addEventListener("click", closeSidebar);

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape") {
                closeSidebar();
            }
        });

        sidebar.querySelectorAll(".sidebar-link").forEach(link => {
            link.addEventListener("click", closeSidebar);
        });

        /* LOGOUT */

        logoutButton.addEventListener("click", async function () {
            logoutButton.disabled = true;
            logoutButton.querySelector("span:last-child").textContent =
                "Logging out...";

            try {
                await fetch("/api/logout", {
                    method: "POST",
                    credentials: "same-origin"
                });
            } catch (error) {
                console.error("Logout request failed:", error);
            }

            localStorage.removeItem("currentUser");
            localStorage.removeItem("role");
            localStorage.removeItem("selectedTest");

            window.location.href = "../../index.html";
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeSidebar);
    } else {
        initializeSidebar();
    }

})();
