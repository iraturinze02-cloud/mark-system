import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/*
 * FILA GRADES — ACADEMIC YEAR PERFORMANCE ANALYSIS
 *
 * Uses the existing schema:
 * tests, test_schools, test_classes, test_subjects, marks,
 * students, student_enrollments, schools, classes,
 * subjects, academic_years and terms.
 *
 * Includes both OPEN and CLOSED tests. Marks that have not yet
 * been entered remain NULL and are not treated as zero.
 */

function validId(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function onRequestGet(context) {
    const auth = await authenticateRole(context, [
        "sector_admin",
        "school_admin",
        "dos"
    ]);

    if (auth.error) return auth.error;

    const url = new URL(context.request.url);
    const academicYear = (url.searchParams.get("academic_year") || "").trim();

    let client;

    try {
        client = await connectDB(context);

        let scopeJoin = "";
        let scopeWhere = "";
        let scopeParams = [];

        if (auth.role === "sector_admin") {
            if (!auth.sectorId) {
                return json({ success: false, message: "Your account is not linked to a sector." }, 403);
            }

            scopeJoin = "INNER JOIN schools scope_school ON scope_school.id = ts.school_id";
            scopeWhere = "scope_school.sector_id = $1";
            scopeParams = [auth.sectorId];
        } else {
            if (!auth.schoolId) {
                return json({ success: false, message: "Your account is not linked to a school." }, 403);
            }

            scopeJoin = "INNER JOIN schools scope_school ON scope_school.id = ts.school_id";
            scopeWhere = "scope_school.id = $1";
            scopeParams = [auth.schoolId];
        }

        const yearsResult = await client.query(
            `
            SELECT
                ay.year_name,
                MIN(ay.start_date) AS start_date,
                MAX(ay.end_date) AS end_date,
                COUNT(DISTINCT t.id) AS total_tests,
                COUNT(DISTINCT ay.school_id) AS total_schools
            FROM academic_years ay
            INNER JOIN schools s ON s.id = ay.school_id
            LEFT JOIN test_schools ts
                ON ts.academic_year_id = ay.id
               AND ts.school_id = ay.school_id
            LEFT JOIN tests t ON t.id = ts.test_id
            WHERE ${auth.role === "sector_admin" ? "s.sector_id = $1" : "s.id = $1"}
            GROUP BY ay.year_name
            ORDER BY MAX(ay.start_date) DESC NULLS LAST, ay.year_name DESC
            `,
            scopeParams
        );

        const academicYears = yearsResult.rows.map(row => ({
            name: row.year_name,
            start_date: row.start_date,
            end_date: row.end_date,
            total_tests: Number(row.total_tests || 0),
            total_schools: Number(row.total_schools || 0)
        }));

        const schoolsResult = await client.query(
            `
            SELECT id, school_name
            FROM schools
            WHERE ${auth.role === "sector_admin" ? "sector_id = $1" : "id = $1"}
            ORDER BY school_name
            `,
            scopeParams
        );

        const schools = schoolsResult.rows.map(row => ({
            id: String(row.id),
            name: row.school_name
        }));

        if (!academicYear) {
            return json({
                success: true,
                user: { role: auth.role, schoolId: auth.schoolId, sectorId: auth.sectorId },
                academic_years: academicYears,
                schools,
                tests: [],
                rows: []
            });
        }

        if (academicYear.length > 100) {
            return json({ success: false, message: "Invalid academic year." }, 400);
        }

        const params = [...scopeParams, academicYear];
        const yearParam = `$${params.length}`;

        const result = await client.query(
            `
            WITH active_enrollments AS (
                SELECT DISTINCT ON (
                    se.student_id,
                    se.school_id,
                    se.class_id,
                    se.academic_year_id,
                    se.term_id
                )
                    se.student_id,
                    se.school_id,
                    se.class_id,
                    se.academic_year_id,
                    se.term_id,
                    se.subclass_id
                FROM student_enrollments se
                WHERE LOWER(TRIM(se.status)) = 'active'
                ORDER BY
                    se.student_id,
                    se.school_id,
                    se.class_id,
                    se.academic_year_id,
                    se.term_id,
                    se.updated_at DESC NULLS LAST,
                    se.id DESC
            )
            SELECT
                t.id AS test_id,
                t.test_name,
                t.status AS test_status,
                t.created_at AS test_created_at,

                ts.academic_year_id,
                ts.term_id,
                ay.year_name,
                tm.term_number,
                tm.term_name,

                sch.id AS school_id,
                sch.school_name,

                c.id AS class_id,
                c.class_name,
                c.level_id,

                sub.id AS subject_id,
                sub.subject_name,
                sub.subject_code,
                test_subject.total_marks,

                st.id AS student_id,
                st.full_name AS student_name,
                st.student_code,
                st.gender,

                enrollment.subclass_id,
                scs.subclass_name,

                latest_mark.score

            FROM tests t
            INNER JOIN test_schools ts ON ts.test_id = t.id
            ${scopeJoin}
            INNER JOIN schools sch ON sch.id = ts.school_id
            INNER JOIN academic_years ay
                ON ay.id = ts.academic_year_id
               AND ay.school_id = ts.school_id
            INNER JOIN terms tm
                ON tm.id = ts.term_id
               AND tm.academic_year_id = ts.academic_year_id
               AND tm.school_id = ts.school_id
            INNER JOIN test_classes tc
                ON tc.test_id = t.id
               AND tc.school_id = ts.school_id
            INNER JOIN classes c ON c.id = tc.class_id
            INNER JOIN test_subjects test_subject ON test_subject.test_id = t.id
            INNER JOIN subjects sub ON sub.id = test_subject.subject_id

            LEFT JOIN active_enrollments enrollment
                ON enrollment.school_id = ts.school_id
               AND enrollment.class_id = tc.class_id
               AND enrollment.academic_year_id = ts.academic_year_id
               AND enrollment.term_id = ts.term_id

            LEFT JOIN students st
                ON st.id = enrollment.student_id
               AND st.school_id = ts.school_id
               AND LOWER(TRIM(st.status)) = 'active'

            LEFT JOIN school_class_subclasses scs
                ON scs.id = enrollment.subclass_id
               AND scs.school_id = enrollment.school_id
               AND scs.academic_year_id = enrollment.academic_year_id
               AND scs.class_id = enrollment.class_id

            LEFT JOIN LATERAL (
                SELECT mk.score
                FROM marks mk
                WHERE mk.test_id = t.id
                  AND mk.student_id = st.id
                  AND mk.class_id = tc.class_id
                  AND mk.subject_id = sub.id
                ORDER BY mk.updated_at DESC NULLS LAST, mk.id DESC
                LIMIT 1
            ) latest_mark ON TRUE

            WHERE ${scopeWhere}
              AND ay.year_name = ${yearParam}

            ORDER BY
                t.created_at ASC NULLS LAST,
                t.id ASC,
                sch.school_name,
                c.class_name,
                st.full_name,
                sub.subject_name
            `,
            params
        );

        const testsMap = new Map();

        for (const row of result.rows) {
            const testId = String(row.test_id);

            if (!testsMap.has(testId)) {
                testsMap.set(testId, {
                    id: testId,
                    name: row.test_name,
                    status: row.test_status,
                    created_at: row.test_created_at,
                    term_number: Number(row.term_number),
                    term_name: row.term_name,
                    schools: new Set()
                });
            }
            testsMap.get(testId).schools.add(String(row.school_id));
        }

        const rows = result.rows.map(row => ({
            test_id: String(row.test_id),
            test_name: row.test_name,
            test_status: row.test_status,
            test_created_at: row.test_created_at,
            term_number: Number(row.term_number),
            term_name: row.term_name,

            school_id: String(row.school_id),
            school_name: row.school_name,

            class_id: String(row.class_id),
            class_name: row.class_name,
            class_level: Number(row.level_id),

            subject_id: String(row.subject_id),
            subject_name: row.subject_name,
            subject_code: row.subject_code,
            maximum_mark: Number(row.total_marks),

            student_id: row.student_id === null ? null : String(row.student_id),
            student_name: row.student_name,
            student_code: row.student_code,
            gender: row.gender,
            subclass_id: row.subclass_id === null ? null : String(row.subclass_id),
            subclass_name: row.subclass_name,

            score: row.score === null ? null : Number(row.score)
        }));

        const tests = Array.from(testsMap.values()).map(test => ({
            id: test.id,
            name: test.name,
            status: test.status,
            created_at: test.created_at,
            term_number: test.term_number,
            term_name: test.term_name,
            total_schools: test.schools.size
        }));

        return json({
            success: true,
            user: { role: auth.role, schoolId: auth.schoolId, sectorId: auth.sectorId },
            academic_years: academicYears,
            schools,
            selected_academic_year: academicYear,
            tests,
            rows
        });

    } catch (error) {
        console.error("Academic Year Performance API error:", error);
        return json({
            success: false,
            message: "Unable to load academic year performance analysis."
        }, 500);
    } finally {
        if (client) await client.end().catch(() => {});
    }
}
