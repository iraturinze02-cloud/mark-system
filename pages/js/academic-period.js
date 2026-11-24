
/* =====================================================
   FILA GRADES SYSTEM
   SHARED ACADEMIC PERIOD SELECTOR
===================================================== */

(function () {
    "use strict";

    const API_URL = "/api/academic-calendar?action=get";

    let calendarData = null;
    let currentUserId = null;
    let selectedPeriod = null;

    let yearSelect = null;
    let termSelect = null;
    let initialized = false;

    /* =================================================
       USER-SPECIFIC STORAGE
    ================================================= */

    function storageKey() {
        return `fila_academic_period_${currentUserId}`;
    }

    function savePeriod(period) {
        if (!currentUserId || !period) return;

        try {
            localStorage.setItem(
                storageKey(),
                JSON.stringify(period)
            );
        } catch (error) {
            console.error(
                "Unable to save academic period:",
                error
            );
        }
    }

    function getSavedPeriod() {
        if (!currentUserId) return null;

        try {
            const saved = localStorage.getItem(storageKey());
            return saved ? JSON.parse(saved) : null;
        } catch {
            return null;
        }
    }

    /* =================================================
       PUBLIC API
    ================================================= */

    function getSelection() {
        return selectedPeriod
            ? { ...selectedPeriod }
            : null;
    }

    /* =================================================
       EVENTS
    ================================================= */

    function dispatchReady() {
        window.dispatchEvent(
            new CustomEvent("fila:academic-period-ready", {
                detail: getSelection()
            })
        );
    }

    function dispatchChange(previous) {
        window.dispatchEvent(
            new CustomEvent("fila:academic-period-change", {
                detail: getSelection()
            })
        );
    }

    /* =================================================
       CREATE STYLES
    ================================================= */

    function addStyles() {
        if (document.getElementById("fila-period-styles")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "fila-period-styles";

        style.textContent = `
            #fila-period-button {
                position: fixed;
                top: 15px;
                right: 18px;
                z-index: 9998;
                width: 43px;
                height: 43px;
                border: 1px solid #dbeafe;
                border-radius: 50%;
                background: white;
                color: #1d4ed8;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                box-shadow: 0 3px 12px rgba(0,0,0,.15);
            }

            #fila-period-button:hover {
                background: #eff6ff;
            }

            #fila-period-button:disabled {
                opacity: .5;
                cursor: not-allowed;
            }

            #fila-period-button svg {
                width: 22px;
                height: 22px;
            }

            #fila-period-modal {
                display: none;
                position: fixed;
                inset: 0;
                z-index: 9999;
                background: rgba(15,23,42,.55);
                align-items: center;
                justify-content: center;
                padding: 15px;
            }

            #fila-period-modal.open {
                display: flex;
            }

            .fila-period-box {
                width: 100%;
                max-width: 430px;
                background: white;
                border-radius: 14px;
                padding: 24px;
                box-shadow: 0 15px 45px rgba(0,0,0,.2);
                box-sizing: border-box;
            }

            .fila-period-heading {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 22px;
            }

            .fila-period-heading h2 {
                margin: 0;
                font-size: 20px;
                color: #173f70;
            }

            #fila-period-close {
                border: none;
                background: #f1f5f9;
                border-radius: 50%;
                width: 34px;
                height: 34px;
                font-size: 20px;
                cursor: pointer;
            }

            .fila-period-field {
                margin-bottom: 18px;
            }

            .fila-period-field label {
                display: block;
                font-weight: 700;
                font-size: 13px;
                margin-bottom: 7px;
                color: #334155;
            }

            .fila-period-field select {
                width: 100%;
                padding: 12px;
                border: 1px solid #cbd5e1;
                border-radius: 8px;
                font-size: 15px;
                background: white;
                box-sizing: border-box;
            }

            #fila-period-current {
                background: #eff6ff;
                border-radius: 8px;
                padding: 11px;
                font-size: 13px;
                color: #1e40af;
                margin-bottom: 18px;
            }

            .fila-period-actions {
                display: flex;
                gap: 10px;
            }

            .fila-period-actions button {
                flex: 1;
                padding: 12px;
                border: none;
                border-radius: 8px;
                font-weight: 700;
                cursor: pointer;
            }

            #fila-period-apply {
                background: #1d4ed8;
                color: white;
            }

            #fila-period-apply:hover {
                background: #1e40af;
            }

            #fila-period-cancel {
                background: #e2e8f0;
                color: #334155;
            }

            #fila-period-error {
                color: #dc2626;
                font-size: 13px;
                margin-bottom: 12px;
            }

            @media(max-width: 600px) {
                #fila-period-button {
                    top: 10px;
                    right: 10px;
                }

                .fila-period-box {
                    padding: 19px;
                }
            }
        `;

        document.head.appendChild(style);
    }

    /* =================================================
       CREATE MODAL
    ================================================= */

    function createModal() {
        if (
            document.getElementById("fila-period-button") ||
            document.getElementById("fila-period-modal")
        ) {
            return;
        }

        const button = document.createElement("button");

        button.id = "fila-period-button";
        button.type = "button";
        button.title = "Change academic period";
        button.setAttribute(
            "aria-label",
            "Change academic period"
        );
        button.disabled = true;

        button.innerHTML = `
            <svg viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round">
                <rect x="3" y="5" width="18" height="16" rx="2"/>
                <path d="M16 3v4M8 3v4M3 10h18"/>
            </svg>
        `;

        button.addEventListener("click", openModal);
        document.body.appendChild(button);

        const modal = document.createElement("div");
        modal.id = "fila-period-modal";

        modal.innerHTML = `
            <div class="fila-period-box">

                <div class="fila-period-heading">
                    <h2>Academic Period</h2>

                    <button
                        type="button"
                        id="fila-period-close"
                        aria-label="Close">
                        &times;
                    </button>
                </div>

                <div id="fila-period-current"></div>

                <div class="fila-period-field">
                    <label for="fila-period-year">
                        Academic Year
                    </label>
                    <select id="fila-period-year"></select>
                </div>

                <div class="fila-period-field">
                    <label for="fila-period-term">
                        Term
                    </label>
                    <select id="fila-period-term"></select>
                </div>

                <div id="fila-period-error" role="alert"></div>

                <div class="fila-period-actions">
                    <button
                        type="button"
                        id="fila-period-cancel">
                        Cancel
                    </button>

                    <button
                        type="button"
                        id="fila-period-apply">
                        Apply
                    </button>
                </div>

            </div>
        `;

        document.body.appendChild(modal);

        yearSelect = document.getElementById(
            "fila-period-year"
        );

        termSelect = document.getElementById(
            "fila-period-term"
        );

        document.getElementById(
            "fila-period-close"
        ).addEventListener("click", closeModal);

        document.getElementById(
            "fila-period-cancel"
        ).addEventListener("click", closeModal);

        document.getElementById(
            "fila-period-apply"
        ).addEventListener("click", applyPeriod);

        yearSelect.addEventListener(
            "change",
            populateTerms
        );

        modal.addEventListener("click", function (event) {
            if (event.target === modal) {
                closeModal();
            }
        });

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape") {
                closeModal();
            }
        });
    }

    /* =================================================
       LOAD ACADEMIC CALENDAR
    ================================================= */

    async function loadCalendar() {
        const response = await fetch(API_URL, {
            method: "GET",
            credentials: "same-origin",
            headers: {
                "Accept": "application/json"
            },
            cache: "no-store"
        });

        const data = await response.json().catch(() => null);

        if (!data) {
            throw new Error(
                "The academic calendar returned an invalid response."
            );
        }

        if (response.status === 401) {
            window.location.href = "/index.html";
            return false;
        }

        if (!response.ok || !data.success) {
            throw new Error(
                data.message ||
                "Unable to load academic calendar."
            );
        }

        if (
            !data.user ||
            data.user.userId === undefined ||
            data.user.userId === null ||
            String(data.user.userId).trim() === ""
        ) {
            throw new Error(
                "Authenticated user ID was not returned by the academic calendar API."
            );
        }

        currentUserId = String(data.user.userId);
        calendarData = data;

        const years = Array.isArray(data.academic_years)
            ? data.academic_years
            : [];

        if (!years.length) {
            throw new Error(
                "No academic years are available."
            );
        }

        const saved = getSavedPeriod();

        const activeYear = data.active_academic_year;
        const activeTerm = data.active_term;

        let defaultYear = null;
        let defaultTerm = null;

        /* ---------------------------------------------
           RESTORE SAVED PERIOD USING REAL DATABASE IDS
        --------------------------------------------- */

        if (saved) {
            defaultYear = years.find(year =>
                String(year.id) ===
                String(saved.academic_year_id)
            ) || null;

            if (defaultYear) {
                defaultTerm = (defaultYear.terms || []).find(term =>
                    String(term.id) === String(saved.term_id)
                ) || null;
            }
        }

        /* ---------------------------------------------
           OTHERWISE USE THE ACTIVE PERIOD
        --------------------------------------------- */

        if (!defaultYear && activeYear) {
            defaultYear = years.find(year =>
                String(year.id) === String(activeYear.id) ||
                year.year_name === activeYear.year_name
            ) || null;
        }

        if (defaultYear && activeTerm) {
            defaultTerm = (defaultYear.terms || []).find(term =>
                String(term.id) === String(activeTerm.id) ||
                Number(term.term_number) ===
                Number(activeTerm.term_number)
            ) || null;
        }

        /* ---------------------------------------------
           FALLBACK TO MOST RECENT AVAILABLE YEAR
        --------------------------------------------- */

        if (!defaultYear) {
            defaultYear = [...years].sort((a, b) =>
                String(b.start_date || "").localeCompare(
                    String(a.start_date || "")
                )
            )[0];
        }

        /* ---------------------------------------------
           FALLBACK TO ACTIVE OR FIRST TERM
        --------------------------------------------- */

        if (!defaultTerm) {
            defaultTerm =
                (defaultYear.terms || []).find(term =>
                    term.status === "active"
                ) ||
                [...(defaultYear.terms || [])].sort((a, b) =>
                    Number(a.term_number) -
                    Number(b.term_number)
                )[0] ||
                null;
        }

        if (!defaultTerm) {
            throw new Error(
                "No terms are available for the selected academic year."
            );
        }

        /* ---------------------------------------------
           STORE COMPLETE PERIOD INCLUDING DATABASE IDS
        --------------------------------------------- */

        selectedPeriod = {
            academic_year_id: Number(defaultYear.id),
            academic_year: defaultYear.year_name,

            term_id: Number(defaultTerm.id),
            term: defaultTerm.term_name,
            term_name: defaultTerm.term_name,

            term_number: Number(defaultTerm.term_number)
        };

        savePeriod(selectedPeriod);

        /* ---------------------------------------------
           EXPOSE PUBLIC API
        --------------------------------------------- */

        window.FilaAcademicPeriod = {
            getSelection: getSelection,

            // Backward-compatible aliases
            getCurrent: getSelection,

            open: openModal,
            refresh: loadCalendar
        };

        dispatchReady();

        return true;
    }

    /* =================================================
       POPULATE ACADEMIC YEARS
    ================================================= */

    function populateYears() {
        yearSelect.innerHTML = "";

        const years = [...calendarData.academic_years];

        years.sort((a, b) =>
            String(b.start_date || "").localeCompare(
                String(a.start_date || "")
            )
        );

        years.forEach(year => {
            const option = document.createElement("option");

            option.value = String(year.id);
            option.textContent =
                year.year_name +
                (year.status === "active" ? " (Current)" : "");

            yearSelect.appendChild(option);
        });

        yearSelect.value = String(
            selectedPeriod.academic_year_id
        );

        populateTerms();
    }

    /* =================================================
       POPULATE TERMS
    ================================================= */

    function populateTerms() {
        termSelect.innerHTML = "";

        const year = calendarData.academic_years.find(
            item => String(item.id) === String(yearSelect.value)
        );

        const terms = Array.isArray(year?.terms)
            ? [...year.terms]
            : [];

        if (!terms.length) {
            const option = document.createElement("option");

            option.value = "";
            option.textContent = "No terms available";

            termSelect.appendChild(option);
            return;
        }

        terms.sort((a, b) =>
            Number(a.term_number) - Number(b.term_number)
        );

        terms.forEach(term => {
            const option = document.createElement("option");

            option.value = String(term.id);
            option.textContent =
                term.term_name +
                (term.status === "active" ? " (Current)" : "");

            termSelect.appendChild(option);
        });

        const isSelectedYear =
            String(year.id) ===
            String(selectedPeriod.academic_year_id);

        const preferredTerm = isSelectedYear
            ? selectedPeriod.term_id
            : (
                terms.find(term => term.status === "active") ||
                terms[0]
            ).id;

        const preferredExists = terms.some(term =>
            String(term.id) === String(preferredTerm)
        );

        termSelect.value = String(
            preferredExists
                ? preferredTerm
                : terms[0].id
        );
    }

    /* =================================================
       OPEN / CLOSE MODAL
    ================================================= */

    function openModal() {
        if (!calendarData || !selectedPeriod) return;

        populateYears();

        document.getElementById(
            "fila-period-error"
        ).textContent = "";

        document.getElementById(
            "fila-period-modal"
        ).classList.add("open");

        updateCurrentLabel();
    }

    function closeModal() {
        const modal = document.getElementById(
            "fila-period-modal"
        );

        if (modal) {
            modal.classList.remove("open");
        }
    }

    /* =================================================
       CURRENT PERIOD LABEL
    ================================================= */

    function updateCurrentLabel() {
        const label = document.getElementById(
            "fila-period-current"
        );

        if (!label || !selectedPeriod) return;

        label.textContent =
            "Currently viewing: " +
            selectedPeriod.academic_year +
            " — " +
            selectedPeriod.term;
    }

    /* =================================================
       APPLY SELECTION
    ================================================= */

    function applyPeriod() {
        const year = calendarData.academic_years.find(
            item => String(item.id) === String(yearSelect.value)
        );

        const term = year?.terms?.find(item =>
            String(item.id) === String(termSelect.value)
        );

        if (!year || !term) {
            document.getElementById(
                "fila-period-error"
            ).textContent =
                "Please select a valid academic year and term.";

            return;
        }

        const previous = getSelection();

        const next = {
            academic_year_id: Number(year.id),
            academic_year: year.year_name,

            term_id: Number(term.id),
            term: term.term_name,
            term_name: term.term_name,

            term_number: Number(term.term_number)
        };

        const changed =
            !previous ||
            Number(previous.academic_year_id) !==
                Number(next.academic_year_id) ||
            Number(previous.term_id) !==
                Number(next.term_id);

        selectedPeriod = next;

        savePeriod(selectedPeriod);

        closeModal();
        updateCurrentLabel();

        if (changed) {
            dispatchChange(previous);
        }
    }

    /* =================================================
       INITIALIZE
    ================================================= */

    async function initialize() {
        if (initialized) return;

        initialized = true;

        addStyles();
        createModal();

        const button = document.getElementById(
            "fila-period-button"
        );

        try {
            const loaded = await loadCalendar();

            if (!loaded) return;

            if (button) {
                button.disabled = false;
                button.title = "Change academic period";
            }

        } catch (error) {
            console.error(
                "Fila academic period error:",
                error
            );

            if (button) {
                button.disabled = true;
                button.title = error.message;
            }

            window.dispatchEvent(
                new CustomEvent("fila:academic-period-error", {
                    detail: {
                        message: error.message
                    }
                })
            );
        }
    }

    /* =================================================
       START
    ================================================= */

    if (document.readyState === "loading") {
        document.addEventListener(
            "DOMContentLoaded",
            initialize,
            { once: true }
        );
    } else {
        initialize();
    }

})();
