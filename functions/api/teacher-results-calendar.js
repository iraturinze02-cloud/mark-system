
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

function validId(value) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0
        ? number
        : null;
}

function dateOnly(value) {
    if (!value) return null;

    return typeof value === "string"
        ? value.slice(0, 10)
        : new Date(value).toISOString().slice(0, 10);
}

function calculateStatus(startDate, endDate) {
    const today = new Date().toISOString().slice(0, 10);
    const start = dateOnly(startDate);
    const end = dateOnly(endDate);

    if (!start || !end) return "upcoming";
    if (today < start) return "upcoming";
    if (today > end) return "completed";

    return "active";
}

export async function onRequestGet(context) {
    const auth = await authenticateRole(context, [
        "teacher",
        "school_admin",
        "sector_admin"
    ]);

    if (auth.error) return auth.error;

    const url = new URL(context.request.url);

    let schoolId;

    if (["teacher", "school_admin"].includes(auth.role)) {
        schoolId = validId(auth.schoolId);

        if (!schoolId) {
            return json({
                success: false,
                message: "Your account is not linked to a school."
            }, 403);
        }
    } else {
        schoolId = validId(url.searchParams.get("school_id"));

        if (!schoolId) {
            return json({
                success: false,
                message: "Please select a valid school."
            }, 400);
        }
    }

    let client;

    try {
        client = await connectDB(context);

        // Confirm that the selected school is accessible.
        let schoolQuery = `
            SELECT id, school_name
            FROM schools
            WHERE id = $1
        `;

        const schoolParams = [schoolId];

        if (auth.role === "sector_admin") {
            schoolQuery += ` AND sector_id = $2`;
            schoolParams.push(auth.sectorId);
        }

        const schoolResult = await client.query(
            schoolQuery,
            schoolParams
        );

        if (schoolResult.rowCount === 0) {
            return json({
                success: false,
                message: "This school is not accessible."
            }, 403);
        }

        const result = await client.query(
            `
            SELECT
                ay.id AS academic_year_id,
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
            [schoolId]
        );

        const yearsMap = new Map();

        for (const row of result.rows) {
            const yearId = String(row.academic_year_id);

            if (!yearsMap.has(yearId)) {
                yearsMap.set(yearId, {
                    id: yearId,
                    year_name: row.year_name,
                    start_date: dateOnly(row.year_start_date),
                    end_date: dateOnly(row.year_end_date),
                    status: calculateStatus(
                        row.year_start_date,
                        row.year_end_date
                    ),
                    terms: []
                });
            }

            if (row.term_id !== null) {
                yearsMap.get(yearId).terms.push({
                    id: String(row.term_id),
                    term_number: Number(row.term_number),
                    term_name: row.term_name,
                    start_date: dateOnly(row.term_start_date),
                    end_date: dateOnly(row.term_end_date),
                    status: calculateStatus(
                        row.term_start_date,
                        row.term_end_date
                    )
                });
            }
        }

        const academicYears = Array.from(yearsMap.values());

        const activeYear =
            academicYears.find(year => year.status === "active") || null;

        const activeTerm = activeYear
            ? activeYear.terms.find(term => term.status === "active") || null
            : null;

        return json({
            success: true,
            school: {
                id: String(schoolResult.rows[0].id),
                school_name: schoolResult.rows[0].school_name
            },
            academic_years: academicYears,
            active_academic_year: activeYear,
            active_term: activeTerm
        });

    } catch (error) {
        console.error("Teacher results calendar error:", {
            message: error?.message,
            code: error?.code
        });

        return json({
            success: false,
            message: "Unable to load this school's academic calendar."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
