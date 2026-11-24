
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =====================================================
   FILA GRADES SYSTEM — SHARED ACADEMIC CALENDAR

   MANAGEMENT:
   - owner
   - sector_admin

   VIEW ONLY:
   - school_admin
   - dos
   - teacher

   DESIGN:
   - One shared academic calendar.
   - Each academic year is replicated for every school.
   - Each term is replicated for every school.
   - Existing examination foreign keys remain valid.

   GET:
   - get
   - get_active

   POST:
   - create_year
   - create_term
===================================================== */


/* =====================================================
   DATE HELPERS
===================================================== */

function dateOnly(value) {

    if (!value) return null;

    if (typeof value === "string") {
        return value.slice(0, 10);
    }

    return new Date(value).toISOString().slice(0, 10);

}


function isValidDate(value) {

    if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        return false;
    }

    const date = new Date(`${value}T00:00:00Z`);

    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );

}


/* =====================================================
   CALCULATE STATUS

   Status is calculated from dates.
   No manual database status update is required.
===================================================== */

function calculateStatus(startDate, endDate) {

    const today = new Date().toISOString().slice(0, 10);

    const start = dateOnly(startDate);
    const end = dateOnly(endDate);

    if (!start || !end) {
        return "upcoming";
    }

    if (today < start) {
        return "upcoming";
    }

    if (today > end) {
        return "completed";
    }

    return "active";

}


/* =====================================================
   AUTHENTICATION
===================================================== */

async function authenticateCalendarUser(context) {

    const auth = await authenticateRole(context, [
        "owner",
        "sector_admin",
        "school_admin",
        "teacher",
        "dos"
    ]);

    if (auth.error) {
        return {
            error: auth.error
        };
    }

    /*
       School Admin, DOS and Teachers must
       be linked to a school.
    */

    if (
        ["school_admin", "dos", "teacher"].includes(auth.role) &&
        !auth.schoolId
    ) {

        return {
            error: json({
                success: false,
                message: "Your account is not linked to a school."
            }, 403)
        };

    }

    return {
        auth
    };

}


/* =====================================================
   CHECK MANAGEMENT PERMISSION
===================================================== */

function canManageCalendar(role) {

    return [
        "owner",
        "sector_admin"
    ].includes(role);

}


/* =====================================================
   GET ACADEMIC CALENDAR
===================================================== */

export async function onRequestGet(context) {

    const authenticated =
        await authenticateCalendarUser(context);

    if (authenticated.error) {
        return authenticated.error;
    }

    const auth = authenticated.auth;

    let client;

    try {

        client = await connectDB(context);

        const url = new URL(context.request.url);

        const action =
            url.searchParams.get("action") || "get";

        if (
            action !== "get" &&
            action !== "get_active"
        ) {

            return json({
                success: false,
                message: "Invalid academic calendar action."
            }, 400);

        }


        /* =================================================
           LOAD CALENDAR

           School Admin, DOS and Teachers see only
           their own school's replicated records.

           Owner and Sector Admin see the shared calendar.
        ================================================= */

        let query;
        let parameters = [];

        if (
            ["school_admin", "dos", "teacher"].includes(auth.role)
        ) {

            query = `
                SELECT

                    ay.id AS academic_year_id,
                    ay.school_id,
                    ay.year_name,
                    ay.start_date AS year_start_date,
                    ay.end_date AS year_end_date,

                    t.id AS term_id,
                    t.term_number,
                    t.term_name,
                    t.start_date AS term_start_date,
                    t.end_date AS term_end_date

                FROM academic_years ay

                LEFT JOIN terms t
                    ON t.academic_year_id = ay.id
                   AND t.school_id = ay.school_id

                WHERE ay.school_id = $1

                ORDER BY
                    ay.start_date DESC NULLS LAST,
                    ay.id DESC,
                    t.term_number ASC
            `;

            parameters = [auth.schoolId];

        } else {

            query = `
                SELECT

                    ay.id AS academic_year_id,
                    ay.school_id,
                    ay.year_name,
                    ay.start_date AS year_start_date,
                    ay.end_date AS year_end_date,

                    t.id AS term_id,
                    t.term_number,
                    t.term_name,
                    t.start_date AS term_start_date,
                    t.end_date AS term_end_date

                FROM academic_years ay

                LEFT JOIN terms t
                    ON t.academic_year_id = ay.id
                   AND t.school_id = ay.school_id

                ORDER BY
                    ay.start_date DESC NULLS LAST,
                    ay.year_name,
                    ay.id,
                    t.term_number ASC
            `;

        }


        const result = await client.query(
            query,
            parameters
        );


        /* =================================================
           ORGANIZE YEARS

           For administrators, identical replicated years
           are grouped into one shared calendar entry.
        ================================================= */

        const yearsMap = new Map();

        for (const row of result.rows) {

            const yearId = String(row.academic_year_id);

            const yearStart = dateOnly(row.year_start_date);
            const yearEnd = dateOnly(row.year_end_date);

            const yearKey =
                auth.role === "owner" ||
                auth.role === "sector_admin"
                    ? `${row.year_name}|${yearStart}|${yearEnd}`
                    : yearId;


            if (!yearsMap.has(yearKey)) {

                yearsMap.set(yearKey, {

                    id: yearId,

                    year_name: row.year_name,

                    start_date: yearStart,

                    end_date: yearEnd,

                    status: calculateStatus(
                        yearStart,
                        yearEnd
                    ),

                    terms: [],

                    school_count: 0

                });

            }


            const year = yearsMap.get(yearKey);


            if (
                auth.role === "owner" ||
                auth.role === "sector_admin"
            ) {

                year.school_count += 1;

            }


            if (row.term_id !== null) {

                const termStart =
                    dateOnly(row.term_start_date);

                const termEnd =
                    dateOnly(row.term_end_date);

                const termKey =
                    `${row.term_number}|${row.term_name}|${termStart}|${termEnd}`;


                let term = year.terms.find(
                    item => item.key === termKey
                );


                if (!term) {

                    term = {

                        id: String(row.term_id),

                        key: termKey,

                        term_number: Number(row.term_number),

                        term_name: row.term_name,

                        start_date: termStart,

                        end_date: termEnd,

                        status: calculateStatus(
                            termStart,
                            termEnd
                        )

                    };

                    year.terms.push(term);

                }

            }

        }


        const academicYears =
            Array.from(yearsMap.values()).map(year => ({

                ...year,

                terms: year.terms
                    .sort(
                        (a, b) =>
                            a.term_number - b.term_number
                    )
                    .map(({ key, ...term }) => term)

            }));


        /* =================================================
           FIND ACTIVE YEAR AND TERM
        ================================================= */

        const activeYear =
            academicYears.find(
                year => year.status === "active"
            ) || null;

        const activeTerm = activeYear
            ? activeYear.terms.find(
                term => term.status === "active"
            ) || null
            : null;


        /* =================================================
           GET ACTIVE PERIOD
        ================================================= */

        if (action === "get_active") {

            return json({

                success: true,

                academic_year: activeYear,

                term: activeTerm,

                user: {
                    userId: auth.userId,
                    role: auth.role,
                    schoolId: auth.schoolId
                }

            });

        }


        /* =================================================
           NORMAL RESPONSE
        ================================================= */

        return json({

            success: true,

            academic_years: academicYears,

            active_academic_year: activeYear,

            active_term: activeTerm,

            user: {
                userId: String(auth.userId),

                role: auth.role,

                schoolId: auth.schoolId

            }

        });

    } catch (error) {

        console.error(
            "Academic calendar loading error:",
            error
        );

        return json({

            success: false,

            message: "Unable to load the academic calendar."

        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }

}


/* =====================================================
   CREATE ACADEMIC YEAR OR TERM
===================================================== */

export async function onRequestPost(context) {

    const authenticated =
        await authenticateCalendarUser(context);

    if (authenticated.error) {
        return authenticated.error;
    }

    const auth = authenticated.auth;


    /* =================================================
       MANAGEMENT PERMISSION

       Only Owner and Sector Admin can modify
       the shared academic calendar.
    ================================================= */

    if (!canManageCalendar(auth.role)) {

        return json({

            success: false,

            message: "You are not authorized to modify the system academic calendar."

        }, 403);

    }


    let client;

    let transactionStarted = false;

    try {

        let body;

        try {

            body = await context.request.json();

        } catch {

            return json({

                success: false,

                message: "Invalid request data."

            }, 400);

        }


        if (!body || typeof body !== "object") {

            return json({

                success: false,

                message: "Invalid request data."

            }, 400);

        }


        const action = body.action;

        if (
            action !== "create_year" &&
            action !== "create_term"
        ) {

            return json({

                success: false,

                message: "Invalid academic calendar action."

            }, 400);

        }


        /* =================================================
           COMMON DATE VALIDATION
        ================================================= */

        const startDate = body.start_date;
        const endDate = body.end_date;

        if (
            !isValidDate(startDate) ||
            !isValidDate(endDate)
        ) {

            return json({

                success: false,

                message: "Please provide valid start and end dates."

            }, 400);

        }


        if (endDate < startDate) {

            return json({

                success: false,

                message: "The end date cannot be before the start date."

            }, 400);

        }


        client = await connectDB(context);

        await client.query("BEGIN");

        transactionStarted = true;


        /* =================================================
           GLOBAL CALENDAR LOCK

           Prevent simultaneous calendar creation.
        ================================================= */

        await client.query(
            `
            SELECT pg_advisory_xact_lock(
                hashtext('fila_grades_system_academic_calendar')
            )
            `
        );


        /* =================================================
           LOAD ALL REGISTERED SCHOOLS
        ================================================= */

        const schoolsResult = await client.query(
            `
            SELECT id
            FROM schools
            ORDER BY id
            `
        );


        if (!schoolsResult.rows.length) {

            await client.query("ROLLBACK");

            transactionStarted = false;

            return json({

                success: false,

                message: "No registered schools were found."

            }, 400);

        }


        const schoolIds = schoolsResult.rows.map(
            school => String(school.id)
        );


        /* =================================================
           ACTION 1: CREATE SHARED ACADEMIC YEAR
        ================================================= */

        if (action === "create_year") {

            const yearName =
                typeof body.year_name === "string"
                    ? body.year_name.trim()
                    : "";


            if (!yearName || yearName.length > 100) {

                await client.query("ROLLBACK");

                transactionStarted = false;

                return json({

                    success: false,

                    message: "Please provide a valid academic year name."

                }, 400);

            }


            /* ---------------------------------------------
               CHECK EXISTING YEAR NAME
            --------------------------------------------- */

            const duplicate = await client.query(
                `
                SELECT id, school_id
                FROM academic_years
                WHERE LOWER(year_name) = LOWER($1)
                LIMIT 1
                `,
                [yearName]
            );


            if (duplicate.rows.length) {

                await client.query("ROLLBACK");

                transactionStarted = false;

                return json({

                    success: false,

                    message: "This academic year already exists in the system."

                }, 409);

            }


            /* ---------------------------------------------
               PREVENT OVERLAPPING YEARS
            --------------------------------------------- */

            const overlap = await client.query(
                `
                SELECT
                    id,
                    year_name,
                    school_id

                FROM academic_years

                WHERE start_date <= $1::date
                  AND end_date >= $2::date

                LIMIT 1
                `,
                [
                    endDate,
                    startDate
                ]
            );


            if (overlap.rows.length) {

                await client.query("ROLLBACK");

                transactionStarted = false;

                return json({

                    success: false,

                    message:
                        `These dates overlap with the existing academic year ${overlap.rows[0].year_name}.`

                }, 409);

            }


            /* ---------------------------------------------
               CREATE YEAR FOR EVERY SCHOOL
            --------------------------------------------- */

            const createdYears = [];

            for (const schoolId of schoolIds) {

                const inserted = await client.query(
                    `
                    INSERT INTO academic_years (
                        school_id,
                        year_name,
                        start_date,
                        end_date,
                        status
                    )

                    VALUES ($1, $2, $3, $4, 'planned')

                    RETURNING
                        id,
                        school_id,
                        year_name,
                        start_date,
                        end_date
                    `,
                    [
                        schoolId,
                        yearName,
                        startDate,
                        endDate
                    ]
                );

                createdYears.push(inserted.rows[0]);

            }


            await client.query("COMMIT");

            transactionStarted = false;


            return json({

                success: true,

                message:
                    "The shared academic year was created successfully for all registered schools.",

                academic_year: {

                    year_name: yearName,

                    start_date: startDate,

                    end_date: endDate,

                    status: calculateStatus(
                        startDate,
                        endDate
                    ),

                    school_count: createdYears.length

                }

            }, 201);

        }


        /* =================================================
           ACTION 2: CREATE SHARED TERM
        ================================================= */

        if (action === "create_term") {

            const academicYearId =
                body.academic_year_id;

            const termName =
                typeof body.term_name === "string"
                    ? body.term_name.trim()
                    : "";

            const termNumber =
                Number(body.term_number);


            if (
                !academicYearId ||
                !/^\d+$/.test(String(academicYearId)) ||
                !termName ||
                termName.length > 100 ||
                !Number.isInteger(termNumber) ||
                termNumber < 1 ||
                termNumber > 20
            ) {

                await client.query("ROLLBACK");

                transactionStarted = false;

                return json({

                    success: false,

                    message: "Please provide valid term details."

                }, 400);

            }


            /* ---------------------------------------------
               FIND THE SELECTED SHARED ACADEMIC YEAR

               The supplied ID identifies one school's
               replicated record.

               We use its year name and dates to identify
               the equivalent record for every other school.
            --------------------------------------------- */

            const yearResult = await client.query(
                `
                SELECT
                    id,
                    school_id,
                    year_name,
                    start_date,
                    end_date

                FROM academic_years

                WHERE id = $1

                LIMIT 1
                `,
                [academicYearId]
            );


            if (!yearResult.rows.length) {

                await client.query("ROLLBACK");

                transactionStarted = false;

                return json({

                    success: false,

                    message: "The selected academic year was not found."

                }, 404);

            }


            const selectedYear = yearResult.rows[0];

            const yearStart = dateOnly(
                selectedYear.start_date
            );

            const yearEnd = dateOnly(
                selectedYear.end_date
            );


            /* ---------------------------------------------
               VERIFY TERM DATES
            --------------------------------------------- */

            if (
                startDate < yearStart ||
                endDate > yearEnd
            ) {

                await client.query("ROLLBACK");

                transactionStarted = false;

                return json({

                    success: false,

                    message:
                        "The term dates must fall within the selected academic year."

                }, 400);

            }


            /* ---------------------------------------------
               VERIFY ALL SCHOOLS HAVE THE SAME YEAR
            --------------------------------------------- */

            const equivalentYears = await client.query(
                `
                SELECT
                    id,
                    school_id

                FROM academic_years

                WHERE year_name = $1
                  AND start_date = $2::date
                  AND end_date = $3::date
                `,
                [
                    selectedYear.year_name,
                    yearStart,
                    yearEnd
                ]
            );


            if (
                equivalentYears.rows.length !== schoolIds.length
            ) {

                await client.query("ROLLBACK");

                transactionStarted = false;

                return json({

                    success: false,

                    message:
                        "The selected academic year is not configured consistently across all schools. Term creation was cancelled."

                }, 409);

            }


            /* ---------------------------------------------
               CHECK DUPLICATE TERM
            --------------------------------------------- */

            const duplicateTerm = await client.query(
                `
                SELECT id

                FROM terms

                WHERE academic_year_id IN (
                    SELECT id
                    FROM academic_years
                    WHERE year_name = $1
                      AND start_date = $2::date
                      AND end_date = $3::date
                )

                AND (
                    term_number = $4
                    OR LOWER(term_name) = LOWER($5)
                )

                LIMIT 1
                `,
                [
                    selectedYear.year_name,
                    yearStart,
                    yearEnd,
                    termNumber,
                    termName
                ]
            );


            if (duplicateTerm.rows.length) {

                await client.query("ROLLBACK");

                transactionStarted = false;

                return json({

                    success: false,

                    message:
                        "This term number or name already exists in the selected academic year."

                }, 409);

            }


            /* ---------------------------------------------
               PREVENT OVERLAPPING TERMS
            --------------------------------------------- */

            const overlappingTerm = await client.query(
                `
                SELECT
                    t.id,
                    t.term_name

                FROM terms t

                INNER JOIN academic_years ay
                    ON ay.id = t.academic_year_id
                   AND ay.school_id = t.school_id

                WHERE ay.year_name = $1
                  AND ay.start_date = $2::date
                  AND ay.end_date = $3::date

                  AND t.start_date <= $4::date
                  AND t.end_date >= $5::date

                LIMIT 1
                `,
                [
                    selectedYear.year_name,
                    yearStart,
                    yearEnd,
                    endDate,
                    startDate
                ]
            );


            if (overlappingTerm.rows.length) {

                await client.query("ROLLBACK");

                transactionStarted = false;

                return json({

                    success: false,

                    message:
                        `These dates overlap with ${overlappingTerm.rows[0].term_name}.`

                }, 409);

            }


            /* ---------------------------------------------
               CREATE TERM FOR EVERY SCHOOL
            --------------------------------------------- */

            const createdTerms = [];

            for (const year of equivalentYears.rows) {

                const inserted = await client.query(
                    `
                    INSERT INTO terms (
                        school_id,
                        academic_year_id,
                        term_number,
                        term_name,
                        start_date,
                        end_date
                    )

                    VALUES ($1, $2, $3, $4, $5, $6)

                    RETURNING
                        id,
                        school_id,
                        academic_year_id,
                        term_number,
                        term_name,
                        start_date,
                        end_date
                    `,
                    [
                        String(year.school_id),
                        String(year.id),
                        termNumber,
                        termName,
                        startDate,
                        endDate
                    ]
                );

                createdTerms.push(inserted.rows[0]);

            }


            await client.query("COMMIT");

            transactionStarted = false;


            return json({

                success: true,

                message:
                    "The shared term was created successfully for all registered schools.",

                term: {

                    term_number: termNumber,

                    term_name: termName,

                    start_date: startDate,

                    end_date: endDate,

                    status: calculateStatus(
                        startDate,
                        endDate
                    ),

                    school_count: createdTerms.length

                }

            }, 201);

        }

    } catch (error) {

        if (client && transactionStarted) {

            await client.query("ROLLBACK").catch(() => {});

        }

        console.error(
            "Academic calendar error:",
            error
        );

        return json({

            success: false,

            message: "Unable to save the academic calendar information."

        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }

}
