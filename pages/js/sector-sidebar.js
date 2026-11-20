
/* =====================================================
   FILA GRADES SYSTEM
   SECTOR ADMIN SIDEBAR
===================================================== */

document.addEventListener("DOMContentLoaded", () => {

    const container = document.getElementById("sectorSidebarContainer");

    if (!container) {
        console.error("Sector sidebar container was not found.");
        return;
    }

    container.innerHTML = `
        <button class="sector-sidebar-toggle"
                id="sectorSidebarToggle"
                aria-label="Open navigation">
            ☰
        </button>

        <div class="sector-sidebar-overlay"
             id="sectorSidebarOverlay"></div>

        <aside class="sector-sidebar" id="sectorSidebar">

            <div class="sector-sidebar-header">
                <h2>FILA GRADES</h2>
                <p>Sector Administration</p>
            </div>

            <nav class="sector-sidebar-nav">

                <div class="sector-sidebar-section">
                    Main Menu
                </div>

                <a href="dashboard.html" class="sidebar-link active">
                    <span class="sidebar-icon">📊</span>
                    <span>Dashboard</span>
                </a>

                <div class="sector-sidebar-section">
                    School Management
                </div>

                <a href="school-admins.html" class="sidebar-link">
                    <span class="sidebar-icon">🏫</span>
                    <span>Schools & Admins</span>
                </a>

                <a href="view-all-students-marks.html" class="sidebar-link">
                    <span class="sidebar-icon">👨‍🎓</span>
                    <span>Students' Marks</span>
                </a>

                <a href="../school/school-marks.html" class="sidebar-link">
                    <span class="sidebar-icon">📈</span>
                    <span>School Records</span>
                </a>

                <div class="sector-sidebar-section">
                    Assessments
                </div>

                <a href="../admin/tests.html" class="sidebar-link">
                    <span class="sidebar-icon">📝</span>
                    <span>Manage Tests</span>
                </a>

            </nav>

            <div class="sector-sidebar-footer">
                <button type="button" id="sectorSidebarLogout">
                    ↪ Logout
                </button>
            </div>

        </aside>
    `;

    const sidebar = document.getElementById("sectorSidebar");
    const toggle = document.getElementById("sectorSidebarToggle");
    const overlay = document.getElementById("sectorSidebarOverlay");
    const logoutButton = document.getElementById("sectorSidebarLogout");

    function closeSidebar() {
        sidebar.classList.remove("open");
        overlay.classList.remove("show");
    }

    toggle.addEventListener("click", () => {
        sidebar.classList.toggle("open");
        overlay.classList.toggle("show");
    });

    overlay.addEventListener("click", closeSidebar);

    sidebar.querySelectorAll(".sidebar-link").forEach(link => {
        link.addEventListener("click", closeSidebar);
    });

    logoutButton.addEventListener("click", () => {
        if (typeof logout === "function") {
            logout();
        } else {
            console.error("Logout function is not available.");
        }
    });

});
