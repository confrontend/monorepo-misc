using System.IO;
using System.Text;
using System.Globalization;
using Microsoft.Data.Sqlite;
using CsvHelper;

using LiveCaptionsTranslator.models;

namespace LiveCaptionsTranslator.utils
{
    public static class SQLiteHistoryLogger
    {
        public static readonly string CONNECTION_STRING = "Data Source=translation_history.db;";

        private static SqliteConnection _sharedConnection;
        private static readonly object _connectionLock = new object();

        static SQLiteHistoryLogger()
        {
            InitializeDatabase();
        }

        private static void InitializeDatabase()
        {
            GetConnection();

            using (var command = new SqliteCommand(@"
                CREATE TABLE IF NOT EXISTS TranslationHistory (
                    Id INTEGER PRIMARY KEY AUTOINCREMENT,
                    Timestamp TEXT,
                    SourceText TEXT,
                    TranslatedText TEXT,
                    TargetLanguage TEXT,
                    ApiUsed TEXT
                );", GetConnection()))
            {
                command.ExecuteNonQuery();
            }
        }

        private static SqliteConnection GetConnection()
        {
            lock (_connectionLock)
            {
                if (_sharedConnection == null)
                {
                    _sharedConnection = new SqliteConnection(CONNECTION_STRING);
                    _sharedConnection.Open();
                }
                else if (_sharedConnection.State != System.Data.ConnectionState.Open)
                {
                    try
                    {
                        _sharedConnection.Open();
                    }
                    catch
                    {
                        _sharedConnection.Dispose();
                        _sharedConnection = new SqliteConnection(CONNECTION_STRING);
                        _sharedConnection.Open();
                    }
                }

                return _sharedConnection;
            }
        }

        public static async Task LogTranslation(string sourceText, string translatedText,
            string targetLanguage, string apiUsed, CancellationToken token = default)
        {
            string insertQuery = @"
                INSERT INTO TranslationHistory (Timestamp, SourceText, TranslatedText, TargetLanguage, ApiUsed)
                VALUES (@Timestamp, @SourceText, @TranslatedText, @TargetLanguage, @ApiUsed)";

            using (var command = new SqliteCommand(insertQuery, GetConnection()))
            {
                command.Parameters.AddWithValue("@Timestamp", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                command.Parameters.AddWithValue("@SourceText", sourceText);
                command.Parameters.AddWithValue("@TranslatedText", translatedText);
                command.Parameters.AddWithValue("@TargetLanguage", targetLanguage);
                command.Parameters.AddWithValue("@ApiUsed", apiUsed);
                await command.ExecuteNonQueryAsync(token);
            }
        }

        public static async Task<(List<TranslationHistoryEntry>, int)> LoadHistoryAsync(
           int page, int maxRow, string searchText, CancellationToken token = default)
        {
            var rawEntries = new List<TranslationHistoryEntry>();

            // 1. Fetch ALL matching raw records sorted by oldest first (ASC) 
            // This ensures our 5-sentence blocks remain fixed and stable over time
            using (var command = new SqliteCommand(@"
        SELECT Timestamp, SourceText, TranslatedText, TargetLanguage, ApiUsed
        FROM TranslationHistory
        WHERE SourceText LIKE @search OR TranslatedText LIKE @search
        ORDER BY Id ASC", GetConnection()))
            {
                command.Parameters.AddWithValue("@search", $"%{searchText}%");
                using (var reader = await command.ExecuteReaderAsync(token))
                {
                    while (await reader.ReadAsync(token))
                    {
                        string unixTime = reader.GetString(reader.GetOrdinal("Timestamp"));
                        DateTime localTime;
                        try
                        {
                            localTime = DateTimeOffset.FromUnixTimeSeconds((long)Convert.ToDouble(unixTime)).LocalDateTime;
                        }
                        catch (FormatException)
                        {
                            // DEPRECATED format migration safety trigger
                            await MigrateOldTimestampFormat();
                            return await LoadHistoryAsync(page, maxRow, string.Empty, token);
                        }

                        rawEntries.Add(new TranslationHistoryEntry
                        {
                            Timestamp = localTime.ToString("yyyy-MM-dd HH:mm"),
                            TimestampFull = localTime.ToString("yyyy-MM-dd HH:mm:ss"),
                            SourceText = reader.GetString(reader.GetOrdinal("SourceText")),
                            TranslatedText = reader.GetString(reader.GetOrdinal("TranslatedText")),
                            TargetLanguage = reader.GetString(reader.GetOrdinal("TargetLanguage")),
                            ApiUsed = reader.GetString(reader.GetOrdinal("ApiUsed"))
                        });
                    }
                }
            }

            // 2. Group the raw lines into solid chunks of up to x sentences
            var groupedHistory = new List<TranslationHistoryEntry>();
            int chunkSize = 15;

            for (int i = 0; i < rawEntries.Count; i += chunkSize)
            {
                // Slice out a block of up to 5 sentences
                var chunk = rawEntries.Skip(i).Take(chunkSize).ToList();

                // The last item in this chunk is the "current/latest" sentence of the block
                var currentEntry = chunk.Last();

                // Any items preceding it form the fixed context for this block
                var contextItems = chunk.Take(chunk.Count - 1).ToList();

                string contextText = contextItems.Count > 0
                    ? string.Join(" ", contextItems.Select(x => x.SourceText)) + " "
                    : string.Empty;

                groupedHistory.Add(new TranslationHistoryEntry
                {
                    Timestamp = currentEntry.Timestamp,
                    TimestampFull = currentEntry.TimestampFull,
                    SourceText = currentEntry.SourceText,       // This will be bolded on the latest row
                    ContextText = contextText,                 // This remains normal font weight
                    TranslatedText = currentEntry.TranslatedText,
                    TargetLanguage = currentEntry.TargetLanguage,
                    ApiUsed = currentEntry.ApiUsed
                });
            }

            // 3. Reverse the grouped list so the newest blocks appear at the top of the UI
            groupedHistory.Reverse();

            // 4. Mark the absolute newest block as IsLatest so its final sentence highlights/bolds
            if (groupedHistory.Count > 0)
            {
                groupedHistory[0].IsLatest = true;
            }

            // 5. Calculate pagination math based on our newly grouped blocks
            int totalCount = groupedHistory.Count;
            int maxPage = Math.Max(1, (int)Math.Ceiling(totalCount / (double)maxRow));
            int offset = Math.Max(0, (page - 1) * maxRow);

            // Slice the specific page items out for the DataGrid view
            var pagedHistory = groupedHistory.Skip(offset).Take(maxRow).ToList();

            return (pagedHistory, maxPage);
        }
        public static async Task ClearHistory(CancellationToken token = default)
        {
            string selectQuery = "DELETE FROM TranslationHistory; DELETE FROM sqlite_sequence WHERE NAME='TranslationHistory'";
            using (var command = new SqliteCommand(selectQuery, GetConnection()))
            {
                await command.ExecuteNonQueryAsync(token);
            }
        }

        public static async Task<string> LoadLastSourceText(CancellationToken token = default)
        {
            string selectQuery = @"
                SELECT SourceText
                FROM TranslationHistory
                ORDER BY Id DESC
                LIMIT 1";

            using (var command = new SqliteCommand(selectQuery, GetConnection()))
            using (var reader = await command.ExecuteReaderAsync(token))
            {
                if (await reader.ReadAsync(token))
                    return reader.GetString(reader.GetOrdinal("SourceText"));
                else
                    return string.Empty;
            }
        }

        public static async Task<TranslationHistoryEntry?> LoadLastTranslation(CancellationToken token = default)
        {
            string selectQuery = @"
                SELECT Timestamp, SourceText, TranslatedText, TargetLanguage, ApiUsed
                FROM TranslationHistory
                ORDER BY Id DESC
                LIMIT 1";

            using (var command = new SqliteCommand(selectQuery, GetConnection()))
            using (var reader = await command.ExecuteReaderAsync(token))
            {
                if (await reader.ReadAsync(token))
                {
                    string unixTime = reader.GetString(reader.GetOrdinal("Timestamp"));
                    DateTime localTime = DateTimeOffset.FromUnixTimeSeconds((long)Convert.ToDouble(unixTime)).LocalDateTime;
                    return new TranslationHistoryEntry
                    {
                        Timestamp = localTime.ToString("yyyy-MM-dd HH:mm"),
                        TimestampFull = localTime.ToString("yyyy-MM-dd HH:mm:ss"),
                        SourceText = reader.GetString(reader.GetOrdinal("SourceText")),
                        TranslatedText = reader.GetString(reader.GetOrdinal("TranslatedText")),
                        TargetLanguage = reader.GetString(reader.GetOrdinal("TargetLanguage")),
                        ApiUsed = reader.GetString(reader.GetOrdinal("ApiUsed"))
                    };
                }
                return null;
            }
        }

        public static async Task DeleteLastTranslation(CancellationToken token = default)
        {
            using (var command = new SqliteCommand(@"
                DELETE FROM TranslationHistory
                WHERE Id IN (SELECT Id FROM TranslationHistory ORDER BY Id DESC LIMIT 1)",
                GetConnection()))
            {
                await command.ExecuteNonQueryAsync(token);
            }
        }

        public static async Task ExportToCSV(string filePath, CancellationToken token = default)
        {
            var history = new List<TranslationHistoryEntry>();

            string selectQuery = @"
                SELECT Timestamp, SourceText, TranslatedText, TargetLanguage, ApiUsed
                FROM TranslationHistory
                ORDER BY Timestamp DESC";

            using (var command = new SqliteCommand(selectQuery, GetConnection()))
            using (var reader = await command.ExecuteReaderAsync(token))
            {
                while (await reader.ReadAsync(token))
                {
                    string unixTime = reader.GetString(reader.GetOrdinal("Timestamp"));
                    DateTime localTime = DateTimeOffset.FromUnixTimeSeconds((long)Convert.ToDouble(unixTime)).LocalDateTime;
                    history.Add(new TranslationHistoryEntry
                    {
                        Timestamp = localTime.ToString("yyyy-MM-dd HH:mm:ss"),
                        TimestampFull = localTime.ToString("yyyy-MM-dd HH:mm:ss"),
                        SourceText = reader.GetString(reader.GetOrdinal("SourceText")),
                        TranslatedText = reader.GetString(reader.GetOrdinal("TranslatedText")),
                        TargetLanguage = reader.GetString(reader.GetOrdinal("TargetLanguage")),
                        ApiUsed = reader.GetString(reader.GetOrdinal("ApiUsed"))
                    });
                }
            }

            using var writer = new StreamWriter(filePath, false, new UTF8Encoding(true));
            using var csvWriter = new CsvWriter(writer, CultureInfo.InvariantCulture);
            await csvWriter.WriteRecordsAsync(history, token);
        }

        // DEPRECATED
        private static async Task MigrateOldTimestampFormat()
        {
            var records = new List<(long id, string timestamp)>();
            using (var command = new SqliteCommand("SELECT Id, Timestamp FROM TranslationHistory", GetConnection()))
            using (var reader = await command.ExecuteReaderAsync())
            {
                while (await reader.ReadAsync())
                {
                    long id = reader.GetInt64(reader.GetOrdinal("Id"));
                    string timestamp = reader.GetString(reader.GetOrdinal("Timestamp"));
                    records.Add((id, timestamp));
                }
            }

            foreach (var (id, timestamp) in records)
            {
                if (DateTime.TryParse(timestamp, out DateTime dt))
                {
                    long unixTime = ((DateTimeOffset)dt).ToUnixTimeSeconds();
                    using var updateCommand = new SqliteCommand(
                        "UPDATE TranslationHistory SET Timestamp = @Timestamp WHERE Id = @Id",
                        GetConnection());
                    updateCommand.Parameters.AddWithValue("@Id", id);
                    updateCommand.Parameters.AddWithValue("@Timestamp", unixTime.ToString());
                    await updateCommand.ExecuteNonQueryAsync();
                }
            }
        }
    }
}