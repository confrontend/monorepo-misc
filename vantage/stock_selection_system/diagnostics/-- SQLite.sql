-- SQLite
SELECT ts, level, logger_name, message, module, function, line, extra_json
FROM diagnostic_events;