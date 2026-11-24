
/* =========================================================
   FILA GRADES SYSTEM
   SHARED ACADEMIC PERIOD SELECTOR
   File: /js/academic-period.js
========================================================= */

(function () {
    "use strict";

    const API_URL = "/api/academic-calendar";

    const STORAGE_PREFIX = "fila_academic_period_";

    let academicYears = [];
    let selectedPeriod = null;
    let currentUser = null;

    /* =====================================================
       STORAGE
    ===================================================== */

    function getStorageKey() {
        const role = currentUser?.role || "user";
        const schoolId = currentUser?.schoolId || "unknown";
        const userId =
            currentUser?.id ||
            currentUser?.userId ||
            currentUser?.user_id;

        // Use the authenticated user's ID when the API provides it.
        // Otherwise, isolate the selection to this browser tab
        // and authenticated school/role.
        const identity = userId
            ? `user_${userId}`
            : `session_${role}_${schoolId}`;

        return STORAGE_PREFIX + identity;
    }

    function saveSelection(period) {
        try {
            sessionStorage.setItem(
                getStorageKey(),
                JSON.stringify(period)
            );
        } catch (error) {
            console.error("Could not save academic period:", error);
        }
    }

    function getSavedSelection() {
        try {
            const saved = sessionStorage.getItem(getStorageKey());

            return saved ? JSON.parse(saved) : null;
        } catch (error) {
            return null;
        }
    }

    /* =====================================================
       HELPERS
    ===================================================== */

    function escapeHTML(value) {
        return String(value ?? "").replace(/[&<>"']/g, function (char) {
            return {
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#039;"
            }[char];
        });
    }

    function findYear(yearId) {
        return academicYears.find(
            year => String(year.id) === String(yearId)
        );
    }

    function findTerm(year, termId) {
        return year?.terms?.find(
            term => String(term.id) === String(termId)
        );
    }

    function getActivePeriod(data) {
        const activeYear = data.active_academic_year;
        const activeTerm = data.active_term;

        if (!activeYear || !activeTerm) {
            return null;
        }

        const year = findYear(activeYear.id);
        const term = findTerm(year, activeTerm.id);

        if (!year || !term) {
            return null;
        }

        return createPeriod(year, term);
    }

    function createPeriod(year, term) {
        return {
            academic_year_id: year.id,
            academic_year: year.year_name,
            term_id: term.id,
            term: term.term_name,
            term_number: term.term_number
        };
    }

    function isSamePeriod(first, second) {
        return first &&
            second &&
            String(first.academic_year_id) ===
                String(second.academic_year_id) &&
            String(first.term_id) === String(second.term_id);
    }

    /* =====================================================
       USER INTERFACE
    ===================================================== */

    function addStyles() {
        if (document.getElementById("filaAcademicPeriodStyles")) {
            return;
        }

        const style = document.createElement("style");

        style.id = "filaAcademicPeriodStyles";

        style.textContent = `
            #filaAcademicPeriodButton {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 9px 13px;
                border: 1px solid #dce2ea;
                border-radius: 9px;
                background: #ffffff;
                color: #263445;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                z-index: 1000;
            }

            #filaAcademicPeriodButton:hover {
                background: #f3f6fa;
            }

            #filaAcademicPeriodButton svg {
                width: 19px;
                height: 19px;
            }

            #filaAcademicPeriodModal {
                position: fixed;
                inset: 0;
                z-index: 99999;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 16px;
                background: rgba(0, 0, 0, 0.48);
            }

            #filaAcademicPeriodModal.show {
                display: flex;
            }

            .fila-period-dialog {
                width: 100%;
                max-width: 420px;
                max-height: 90vh;
                overflow-y: auto;
                padding: 24px;
                border-radius: 14px;
                background: #ffffff;
                box-shadow: 0 15px 45px rgba(0,0,0,0.2);
                font-family: Arial, sans-serif;
            }

            .fila-period-heading {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                margin-bottom: 8px;
            }

            .fila-period-heading h3 {
                margin: 0;
                color: #1e293b;
                font-size: 19px;
            }

            .fila-period-close {
                border: none;
                background: transparent;
                font-size: 25px;
                cursor: pointer;
                color: #64748b;
            }

            .fila-period-description {
                margin: 0 0 22px;
                color: #64748b;
                font-size: 13px;
                line-height: 1.5;
            }

            .fila-period-field {
                margin-bottom: 18px;
            }

            .fila-period-field label {
                display: block;
                margin-bottom: 8px;
                color: #334155;
                font-size: 13px;
                font-weight: 600;
            }

            .fila-period-field select {
                width: 100%;
                padding: 12px;
                border: 1px solid #cbd5e1;
                border-radius: 8px;
                background: #ffffff;
                color: #1e293b;
                font-size: 14px;
                outline: none;
            }

            .fila-period-field select:focus {
                border-color: #2563eb;
            }

            .fila-period-actions {
                display: flex;
                gap: 10px;
                margin-top: 24px;
            }

            .fila-period-actions button {
                flex: 1;
                padding: 12px;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
            }

            #filaPeriodCancel {
                background: #eef2f7;
                color: #334155;
            }

            #filaPeriodApply {
                background: #1d4ed8;
                color: #ffffff;
            }

            #filaPeriodApply:disabled {
                opacity: 0.55;
                cursor: not-allowed;
            }

            #filaPeriodMessage {
                margin-top: 12px;
                color: #dc2626;
                font-size: 13px;
            }

            @media (max-width: 480px) {
                .fila-period-dialog {
                    padding: 19px;
                }

                #filaAcademicPeriodButton .fila-period-button-text {
                    display: none;
                }
            }
        `;

        document.head.appendChild(style);
    }

    function createInterface() {
        if (document.getElementById("filaAcademicPeriodButton")) {
            return;
        }

        addStyles();

        const button = document.createElement("button");

        button.id = "filaAcademicPeriodButton";
        button.type = "button";
        button.title = "Change academic year and term";

        button.innerHTML = `
            <svg viewBox="0 0 24 24"
                 fill="none"
                 stroke="currentColor"
                 stroke-width="2"
                 stroke-linecap="round"
                 stroke-linejoin="round"
                 aria-hidden="true">
                <rect x="3" y="5" width="18" height="16" rx="2"></rect>
                <path d="M16 3v4M8 3v4M3 10h18"></path>
            </svg>
            <span class="fila-period-button-text">
                Academic Period
            </span>
        `;

        // Fixed top-right position.
        button.style.position = "fixed";
        button.style.top = "14px";
        button.style.right = "18px";

        button.addEventListener("click", openModal);

        document.body.appendChild(button);

        const modal = document.createElement("div");

        modal.id = "filaAcademicPeriodModal";

        modal.innerHTML = `
            <div class="fila-period-dialog"
                 role="dialog"
                 aria-modal="true"
                 aria-labelledby="filaPeriodTitle">

                <div class="fila-period-heading">
                    <h3 id="filaPeriodTitle">
                        Select Academic Period
                    </h3>

                    <button type="button"
                            class="fila-period-close"
                            id="filaPeriodClose"
                            aria-label="Close">
                        &times;
                    </button>
                </div>

                <p class="fila-period-description">
                    Choose the academic year and term you want
                    to view throughout the system.
                </p>

                <div class="fila-period-field">
                    <label for="filaPeriodYear">
                        Academic Year
                    </label>

                    <select id="filaPeriodYear"></select>
                </div>

                <div class="fila-period-field">
                    <label for="filaPeriodTerm">
                        Term
                    </label>

                    <select id="filaPeriodTerm"></select>
                </div>

                <div id="filaPeriodMessage"></div>

                <div class="fila-period-actions">
                    <button type="button" id="filaPeriodCancel">
                        Cancel
                    </button>

                    <button type="button" id="filaPeriodApply">
                        Apply Period
                    </button>
                </div>
            </div>
        `;

        modal.addEventListener("click", function (event) {
            if (event.target === modal) {
                closeModal();
            }
        });

        document.body.appendChild(modal);

        document.getElementById("filaPeriodClose")
            .addEventListener("click", closeModal);

        document.getElementById("filaPeriodCancel")
            .addEventListener("click", closeModal);

        document.getElementById("filaPeriodYear")
            .addEventListener("change", populateTerms);

        document.getElementById("filaPeriodApply")
            .addEventListener("click", applySelection);
    }

    /* =====================================================
       MODAL
    ===================================================== */

    function openModal() {
        const modal = document.getElementById(
            "filaAcademicPeriodModal"
        );

        if (!modal) return;

        document.getElementById("filaPeriodMessage").textContent = "";

        populateYears();

        modal.classList.add("show");
    }

    function closeModal() {
        document.getElementById(
            "filaAcademicPeriodModal"
        )?.classList.remove("show");
    }

    function populateYears() {
        const select = document.getElementById("filaPeriodYear");

        select.innerHTML = "";

        academicYears.forEach(year => {
            const option = document.createElement("option");

            option.value = year.id;
            option.textContent = year.year_name;

            select.appendChild(option);
        });

        const selectedYear = findYear(
            selectedPeriod?.academic_year_id
        );

        const activeYear = academicYears.find(year =>
            year.terms?.some(term => term.status === "active")
        );

        const defaultYear = selectedYear || activeYear || academicYears[0];

        if (defaultYear) {
            select.value = defaultYear.id;
        }

        populateTerms();
    }

    function populateTerms() {
        const yearSelect = document.getElementById("filaPeriodYear");
        const termSelect = document.getElementById("filaPeriodTerm");

        const year = findYear(yearSelect.value);

        termSelect.innerHTML = "";

        if (!year || !Array.isArray(year.terms)) {
            return;
        }

        year.terms.forEach(term => {
            const option = document.createElement("option");

            option.value = term.id;
            option.textContent = term.term_name;

            termSelect.appendChild(option);
        });

        const savedTerm = findTerm(year, selectedPeriod?.term_id);

        const activeTerm = year.terms.find(
            term => term.status === "active"
        );

        const defaultTerm = savedTerm || activeTerm || year.terms[0];

        if (defaultTerm) {
            termSelect.value = defaultTerm.id;
        }
    }

    /* =====================================================
       APPLY SELECTION
    ===================================================== */

    function applySelection() {
        const yearId = document.getElementById(
            "filaPeriodYear"
        ).value;

        const termId = document.getElementById(
            "filaPeriodTerm"
        ).value;

        const year = findYear(yearId);
        const term = findTerm(year, termId);

        if (!year || !term) {
            document.getElementById(
                "filaPeriodMessage"
            ).textContent = "Please select a valid academic period.";

            return;
        }

        const newPeriod = createPeriod(year, term);

        selectedPeriod = newPeriod;

        saveSelection(newPeriod);

        updateButtonLabel();

        window.dispatchEvent(
            new CustomEvent("fila:academic-period-change", {
                detail: { ...selectedPeriod }
            })
        );

        closeModal();
    }

    function updateButtonLabel() {
        const button = document.getElementById(
            "filaAcademicPeriodButton"
        );

        if (!button || !selectedPeriod) return;

        button.title =
            `${selectedPeriod.academic_year} - ${selectedPeriod.term}`;

        button.innerHTML = `
            <svg viewBox="0 0 24 24"
                 fill="none"
                 stroke="currentColor"
                 stroke-width="2"
                 stroke-linecap="round"
                 stroke-linejoin="round"
                 aria-hidden="true">
                <rect x="3" y="5" width="18" height="16" rx="2"></rect>
                <path d="M16 3v4M8 3v4M3 10h18"></path>
            </svg>
            <span class="fila-period-button-text">
                ${escapeHTML(selectedPeriod.academic_year)}
                ·
                ${escapeHTML(selectedPeriod.term)}
            </span>
        `;
    }

    /* =====================================================
       LOAD ACADEMIC CALENDAR
    ===================================================== */

    async function initialize() {
        try {
            createInterface();

            const response = await fetch(API_URL, {
                method: "GET",
                credentials: "same-origin",
                headers: {
                    "Accept": "application/json"
                }
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(
                    data.message || "Could not load academic calendar."
                );
            }

            academicYears = Array.isArray(data.academic_years)
                ? data.academic_years
                : [];

            currentUser = data.user || {};

            if (academicYears.length === 0) {
                throw new Error("No academic years are available.");
            }

            const saved = getSavedSelection();

            const savedYear = findYear(saved?.academic_year_id);
            const savedTerm = findTerm(savedYear, saved?.term_id);

            const activePeriod = getActivePeriod(data);

            if (savedYear && savedTerm) {
                selectedPeriod = createPeriod(savedYear, savedTerm);
            } else if (activePeriod) {
                selectedPeriod = activePeriod;
            } else {
                const firstYear = academicYears[0];
                const firstTerm = firstYear.terms?.[0];

                if (firstYear && firstTerm) {
                    selectedPeriod = createPeriod(firstYear, firstTerm);
                }
            }

            if (!selectedPeriod) {
                throw new Error("No valid academic period is available.");
            }

            saveSelection(selectedPeriod);

            updateButtonLabel();

            // Notify pages that the initial period is ready.
            window.dispatchEvent(
                new CustomEvent("fila:academic-period-ready", {
                    detail: { ...selectedPeriod }
                })
            );

        } catch (error) {
            console.error("Academic period initialization failed:", error);

            const button = document.getElementById(
                "filaAcademicPeriodButton"
            );

            if (button) {
                button.title = "Academic period could not be loaded";
            }
        }
    }

    /* =====================================================
       PUBLIC API FOR OTHER PAGES
    ===================================================== */

    window.FilaAcademicPeriod = {
        getSelection: function () {
            return selectedPeriod
                ? { ...selectedPeriod }
                : null;
        },

        open: openModal,

        refresh: initialize
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize);
    } else {
        initialize();
    }

})();
