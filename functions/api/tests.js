
import {
    connectDB,
    requireTestUser,
    json
} from "../_utils.js";

async function closeExpiredTests(client) {
    await client.query(`
        UPDATE tests
        SET status = 'closed',
            closed_at = NOW(),
            updated_at = NOW()
        WHERE status = 'open'
          AND closing_at IS NOT NULL
          AND closing_at <= NOW()
    `);
}

export async function onRequest(context) {
    const auth = await requireTestUser(context);

    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        if (context.request.method === "GET") {
            await closeExpiredTests(client);

            let result;

            if (auth.role === "sector_admin") {
                result = await client.query(`
                    SELECT
                        t.id,
                        t.test_name,
                        t.status,
                        t.closing_at,
                        t.initiated_at,
                        t.closed_at,
                        t.created_at,
                        u.full_name AS creator_name,

                        COALESCE((
                            SELECT json_agg(
                                json_build_object(
                                    'id', s.id,
                                    'school_name', s.school_name
                                )
                                ORDER BY s.school_name
                            )
                            FROM test_schools ts
                            JOIN schools s ON s.id = ts.school_id
                            WHERE ts.test_id = t.id
                        ), '[]'::json) AS schools,

                        COALESCE((
                            SELECT json_agg(
                                json_build_object(
                                    'id', c.id,
                                    'class_name', c.class_name,
                                    'school_id', c.school_id
                                )
                                ORDER BY c.class_name
                            )
                            FROM test_classes tc
                            JOIN classes c ON c.id = tc.class_id
                            WHERE tc.test_id = t.id
                        ), '[]'::json) AS classes,

                        COALESCE((
                            SELECT json_agg(
                                json_build_object(
                                    'id', s.id,
                                    'subject_name', s.subject_name
                                )
                                ORDER BY s.subject_name
                            )
                            FROM test_subjects ts
                            JOIN subjects s ON s.id = ts.subject_id
                            WHERE ts.test_id = t.id
                        ), '[]'::json) AS subjects

                    FROM tests t
                    JOIN users u ON u.id = t.created_by
                    WHERE t.sector_id = $1
                    ORDER BY t.created_at DESC
                `, [auth.sectorId]);

            } else if (auth.role === "school_admin") {
                result = await client.query(`
                    SELECT
                        t.id,
                        t.test_name,
                        t.status,
                        t.closing_at,
                        t.initiated_at,
                        t.closed_at,
                        t.created_at,
                        u.full_name AS creator_name,

                        COALESCE((
                            SELECT json_agg(
                                json_build_object(
                                    'id', s.id,
                                    'school_name', s.school_name
                                )
                            )
                            FROM test_schools ts
                            JOIN schools s ON s.id = ts.school_id
                            WHERE ts.test_id = t.id
                        ), '[]'::json) AS schools,

                        COALESCE((
                            SELECT json_agg(
                                json_build_object(
                                    'id', c.id,
                                    'class_name', c.class_name,
                                    'school_id', c.school_id
                                )
                                ORDER BY c.class_name
                            )
                            FROM test_classes tc
                            JOIN classes c ON c.id = tc.class_id
                            WHERE tc.test_id = t.id
                        ), '[]'::json) AS classes,

                        COALESCE((
                            SELECT json_agg(
                                json_build_object(
                                    'id', s.id,
                                    'subject_name', s.subject_name
                                )
                                ORDER BY s.subject_name
                            )
                            FROM test_subjects ts
                            JOIN subjects s ON s.id = ts.subject_id
                            WHERE ts.test_id = t.id
                        ), '[]'::json) AS subjects

                    FROM tests t
                    JOIN users u ON u.id = t.created_by
                    WHERE t.school_id = $1
                    ORDER BY t.created_at DESC
                `, [auth.schoolId]);

            } else {
                // Teachers only see tests that include at least one
                // class and subject assigned to them.
                result = await client.query(`
                    SELECT DISTINCT
                        t.id,
                        t.test_name,
                        t.status,
                        t.closing_at,
                        t.initiated_at,
                        t.closed_at,
                        t.created_at,
                        u.full_name AS creator_name,

                        COALESCE((
                            SELECT json_agg(
                                json_build_object(
                                    'id', c.id,
                                    'class_name', c.class_name
                                )
                                ORDER BY c.class_name
                            )
                            FROM test_classes tc
                            JOIN classes c ON c.id = tc.class_id
                            WHERE tc.test_id = t.id
                        ), '[]'::json) AS classes,

                        COALESCE((
                            SELECT json_agg(
                                json_build_object(
                                    'id', s.id,
                                    'subject_name', s.subject_name
                                )
                                ORDER BY s.subject_name
                            )
                            FROM test_subjects ts
                            JOIN subjects s ON s.id = ts.subject_id
                            WHERE ts.test_id = t.id
                        ), '[]'::json) AS subjects,

                        '[]'::json AS schools

                    FROM tests t
                    JOIN users u ON u.id = t.created_by
                    JOIN test_classes tc ON tc.test_id = t.id
                    JOIN test_subjects ts ON ts.test_id = t.id
                    JOIN teachers tr ON tr.user_id = $1
                    JOIN teacher_assignments ta
                        ON ta.teacher_id = tr.id
                       AND ta.school_id = tc.school_id
                       AND ta.class_id = tc.class_id
                       AND ta.subject_id = ts.subject_id

                    WHERE t.status IN ('draft', 'open', 'closed')
                    ORDER BY t.created_at DESC
                `, [auth.userId]);
            }

            return json({
                success: true,
                tests: result.rows,
                role: auth.role
            });
        }

        if (context.request.method === "POST") {
            if (!["sector_admin", "school_admin"].includes(auth.role)) {
                return json({
                    success: false,
                    message: "Only administrators can create tests."
                }, 403);
            }

            let data;

            try {
                data = await context.request.json();
            } catch {
                return json({
                    success: false,
                    message: "Invalid request data."
                }, 400);
            }

            const testName = String(data.test_name || "").trim();
            const schoolIds = [...new Set((data.school_ids || []).map(String))];
            const classIds = [...new Set((data.class_ids || []).map(String))];
            const subjectIds = [...new Set((data.subject_ids || []).map(String))];
            const closingAt = data.closing_at || null;

            if (!testName || !classIds.length || !subjectIds.length) {
                return json({
                    success: false,
                    message: "Test name, classes and subjects are required."
                }, 400);
            }

            if (auth.role === "sector_admin" && !schoolIds.length) {
                return json({
                    success: false,
                    message: "Select at least one school."
                }, 400);
            }

            if (auth.role === "school_admin" && schoolIds.length) {
                return json({
                    success: false,
                    message: "School selection is not allowed."
                }, 400);
            }

            if (closingAt && !Number.isFinite(Date.parse(closingAt))) {
                return json({
                    success: false,
                    message: "Invalid closing date and time."
                }, 400);
            }

            if (closingAt && new Date(closingAt).getTime() <= Date.now()) {
                return json({
                    success: false,
                    message: "Closing time must be in the future."
                }, 400);
            }

            await client.query("BEGIN");

            let selectedSchools;

            if (auth.role === "sector_admin") {
                const schoolResult = await client.query(`
                    SELECT id
                    FROM schools
                    WHERE sector_id = $1
                      AND status = 'active'
                      AND id = ANY($2::bigint[])
                `, [auth.sectorId, schoolIds]);

                if (schoolResult.rows.length !== schoolIds.length) {
                    throw new Error("One or more selected schools do not belong to your sector.");
                }

                selectedSchools = schoolResult.rows.map(row => String(row.id));
            } else {
                selectedSchools = [auth.schoolId];
            }

            const classResult = await client.query(`
                SELECT id, school_id
                FROM classes
                WHERE id = ANY($1::bigint[])
                  AND school_id = ANY($2::bigint[])
            `, [classIds, selectedSchools]);

            if (classResult.rows.length !== classIds.length) {
                throw new Error("One or more selected classes do not belong to the selected schools.");
            }

            const subjectResult = await client.query(`
                SELECT id
                FROM subjects
                WHERE id = ANY($1::bigint[])
            `, [subjectIds]);

            if (subjectResult.rows.length !== subjectIds.length) {
                throw new Error("One or more selected subjects do not exist.");
            }

            const testResult = await client.query(`
                INSERT INTO tests (
                    test_name,
                    sector_id,
                    school_id,
                    created_by,
                    closing_at
                )
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
            `, [
                testName,
                auth.role === "sector_admin" ? auth.sectorId : null,
                auth.role === "school_admin" ? auth.schoolId : null,
                auth.userId,
                closingAt
            ]);

            const testId = testResult.rows[0].id;

            for (const schoolId of selectedSchools) {
                await client.query(`
                    INSERT INTO test_schools (test_id, school_id)
                    VALUES ($1, $2)
                `, [testId, schoolId]);
            }

            for (const item of classResult.rows) {
                await client.query(`
                    INSERT INTO test_classes (test_id, school_id, class_id)
                    VALUES ($1, $2, $3)
                `, [testId, item.school_id, item.id]);
            }

            for (const subjectId of subjectIds) {
                await client.query(`
                    INSERT INTO test_subjects (test_id, subject_id)
                    VALUES ($1, $2)
                `, [testId, subjectId]);
            }

            await client.query("COMMIT");

            return json({
                success: true,
                message: "Test created successfully.",
                test_id: String(testId)
            }, 201);
        }

        return json({
            success: false,
            message: "Method not allowed."
        }, 405);

    } catch (error) {
        if (client) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Tests API error:", error);

        return json({
            success: false,
            message: error.message || "Unable to process the test request."
        }, 400);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
