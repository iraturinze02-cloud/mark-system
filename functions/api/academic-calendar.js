
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =====================================================
   ACADEMIC CALENDAR API

   ACCESS:
   - school_admin
   - dos

   Each user can manage only their own school's
   academic calendar.

   ACTIONS:
   GET:
   - get
   - get_active

   POST:
   - create_year
   - create_term
===================================================== */


/* =====================================================
   DATE VALIDATION
===================================================== */

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
   CALCULATE PERIOD STATUS
===================================================== */

function calculateStatus(startDate, endDate) {

    const today = new Date().toISOString().slice(0, 10);

    if (today < startDate) {
        return "upcoming";
    }

    if (today > endDate) {
        return "completed";
    }

    return "active";

}


/* =====================================================
   AUTHENTICATION
===================================================== */

async function authenticateCalendarUser(context) {

    const auth = await authenticateRole(context, [
        "school_admin",
        "dos"
    ]);

    if (auth.error) {
        return {
            error: auth.error
        };
    }

    if (!auth.schoolId) {

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
   GET: ACADEMIC CALENDAR
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
           LOAD ACADEMIC YEARS AND TERMS
        ================================================= */

        const result = await client.query(
            `
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

            `,
            [auth.schoolId]
        );


        /* =================================================
           ORGANIZE ACADEMIC YEARS
        ================================================= */

        const yearsMap = new Map();

        for (const row of result.rows) {

            const yearId = String(row.academic_year_id);

            if (!yearsMap.has(yearId)) {

                yearsMap.set(yearId, {

                    id: yearId,

                    school_id: String(row.school_id),

                    year_name: row.year_name,

                    start_date: row.year_start_date,

                    end_date: row.year_end_date,

                    status: calculateStatus(
                        row.year_start_date,
                        row.year_end_date
                    ),

                    terms: []

                });

            }

            if (row.term_id !== null) {

                const year = yearsMap.get(yearId);

                year.terms.push({

                    id: String(row.term_id),

                    term_number: Number(row.term_number),

                    term_name: row.term_name,

                    start_date: row.term_start_date,

                    end_date: row.term_end_date,

                    status: calculateStatus(
                        row.term_start_date,
                        row.term_end_date
                    )

                });

            }

        }


        const academicYears =
            Array.from(yearsMap.values());


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
           GET ACTIVE ACTION
        ================================================= */

        if (action === "get_active") {

            return json({

                success: true,

                academic_year: activeYear,

                term: activeTerm,

                user: {

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
   POST: CREATE ACADEMIC YEAR OR TERM
===================================================== */

export async function onRequestPost(context) {

    const authenticated =
        await authenticateCalendarUser(context);

    if (authenticated.error) {
        return authenticated.error;
    }

    const auth = authenticated.auth;

    let client;

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
           VALIDATE COMMON DATES
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


        /* =================================================
           LOCK SCHOOL CALENDAR OPERATIONS

           Prevent simultaneous requests from creating
           overlapping academic periods for this school.
        ================================================= */

        await client.query(
            `
            SELECT pg_advisory_xact_lock(
                hashtext('academic_calendar'),
                hashtext($1)
            )
            `,
            [String(auth.schoolId)]
        );


        /* =================================================
           ACTION 1: CREATE ACADEMIC YEAR
        ================================================= */

        if (action === "create_year") {

            const yearName =
                typeof body.year_name === "string"
                    ? body.year_name.trim()
                    : "";

            if (!yearName || yearName.length > 100) {

                await client.query("ROLLBACK");

                return json({
                    success: false,
                    message: "Please provide a valid academic year name."
                }, 400);

            }


            /* ---------------------------------------------
               CHECK DUPLICATE YEAR NAME
            --------------------------------------------- */

            const duplicate = await client.query(
                `
                SELECT id
                FROM academic_years
                WHERE school_id = $1
                  AND LOWER(year_name) = LOWER($2)
                LIMIT 1
                `,
                [auth.schoolId, yearName]
            );

            if (duplicate.rows.length) {

                await client.query("ROLLBACK");

                return json({
                    success: false,
                    message: "This academic year already exists."
                }, 409);

            }


            /* ---------------------------------------------
               PREVENT OVERLAPPING ACADEMIC YEARS
            --------------------------------------------- */

            const overlap = await client.query(
                `
                SELECT id, year_name
                FROM academic_years
                WHERE school_id = $1
                  AND start_date <= $2::date
                  AND end_date >= $3::date
                LIMIT 1
                `,
                [
                    auth.schoolId,
                    endDate,
                    startDate
                ]
            );

            if (overlap.rows.length) {

                await client.query("ROLLBACK");

                return json({
                    success: false,
                    message:
                        `These dates overlap with academic year ${overlap.rows[0].year_name}.`
                }, 409);

            }


            /* ---------------------------------------------
               INSERT ACADEMIC YEAR
            --------------------------------------------- */

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
                    end_date,
                    status
                `,
                [
                    auth.schoolId,
                    yearName,
                    startDate,
                    endDate
                ]
            );

            await client.query("COMMIT");

            const year = inserted.rows[0];

            return json({

                success: true,

                message: "Academic year created successfully.",

                academic_year: {

                    id: String(year.id),

                    school_id: String(year.school_id),

                    year_name: year.year_name,

                    start_date: year.start_date,

                    end_date: year.end_date,

                    status: calculateStatus(
                        year.start_date,
                        year.end_date
                    ),

                    terms: []

                }

            }, 201);

        }


        /* =================================================
           ACTION 2: CREATE TERM
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

                return json({
                    success: false,
                    message: "Please provide valid term details."
                }, 400);

            }


            /* ---------------------------------------------
               VERIFY ACADEMIC YEAR BELONGS TO THIS SCHOOL
            --------------------------------------------- */

            const yearResult = await client.query(
                `
                SELECT
                    id,
                    year_name,
                    start_date,
                    end_date

                FROM academic_years

                WHERE id = $1
                  AND school_id = $2

                LIMIT 1
                `,
                [
                    academicYearId,
                    auth.schoolId
                ]
            );

            if (!yearResult.rows.length) {

                await client.query("ROLLBACK");

                return json({
                    success: false,
                    message: "The selected academic year was not found."
                }, 404);

            }

            const academicYear = yearResult.rows[0];


            /* ---------------------------------------------
               CHECK TERM FALLS WITHIN ACADEMIC YEAR
            --------------------------------------------- */

            if (
                startDate < String(academicYear.start_date).slice(0, 10) ||
                endDate > String(academicYear.end_date).slice(0, 10)
            ) {

                await client.query("ROLLBACK");

                return json({
                    success: false,
                    message:
                        "The term dates must fall within the selected academic year."
                }, 400);

            }


            /* ---------------------------------------------
               PREVENT DUPLICATE TERM NUMBER
            --------------------------------------------- */

            const duplicateTerm = await client.query(
                `
                SELECT id
                FROM terms
                WHERE school_id = $1
                  AND academic_year_id = $2
                  AND (
                      term_number = $3
                      OR LOWER(term_name) = LOWER($4)
                  )
                LIMIT 1
                `,
                [
                    auth.schoolId,
                    academicYearId,
                    termNumber,
                    termName
                ]
            );

            if (duplicateTerm.rows.length) {

                await client.query("ROLLBACK");

                return json({
                    success: false,
                    message:
                        "This term number or term name already exists in the selected academic year."
                }, 409);

            }


            /* ---------------------------------------------
               PREVENT OVERLAPPING TERMS
            --------------------------------------------- */

            const overlappingTerm = await client.query(
                `
                SELECT
                    id,
                    term_name

                FROM terms

                WHERE school_id = $1
                  AND academic_year_id = $2
                  AND start_date <= $3::date
                  AND end_date >= $4::date

                LIMIT 1
                `,
                [
                    auth.schoolId,
                    academicYearId,
                    endDate,
                    startDate
                ]
            );

            if (overlappingTerm.rows.length) {

                await client.query("ROLLBACK");

                return json({
                    success: false,
                    message:
                        `These dates overlap with ${overlappingTerm.rows[0].term_name}.`
                }, 409);

            }


            /* ---------------------------------------------
               INSERT TERM
            --------------------------------------------- */

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
                    auth.schoolId,
                    academicYearId,
                    termNumber,
                    termName,
                    startDate,
                    endDate
                ]
            );

            await client.query("COMMIT");

            const term = inserted.rows[0];

            return json({

                success: true,

                message: "Term created successfully.",

                term: {

                    id: String(term.id),

                    school_id: String(term.school_id),

                    academic_year_id:
                        String(term.academic_year_id),

                    term_number: Number(term.term_number),

                    term_name: term.term_name,

                    start_date: term.start_date,

                    end_date: term.end_date,

                    status: calculateStatus(
                        term.start_date,
                        term.end_date
                    )

                }

            }, 201);

        }

    } catch (error) {

        if (client) {

            await client.query("ROLLBACK").catch(() => {});

        }

        console.error(
            "Academic calendar creation error:",
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
