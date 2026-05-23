using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;
using Wpf.Ui.Appearance;
using Wpf.Ui.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using LiveCaptionsTranslator.models;
using LiveCaptionsTranslator.utils;
using TextBlock = System.Windows.Controls.TextBlock;

namespace LiveCaptionsTranslator
{
    public partial class HistoryPage : Page
    {
        public const int MIN_HEIGHT = 300;

        private int currentPage = 1;
        private int searchPage = 1;
        private int maxPage = 1;
        private int maxRowPerPage = 30;

        public string SearchText { get; set; } = string.Empty;

        public HistoryPage()
        {
            InitializeComponent();
            ApplicationThemeManager.ApplySystemTheme();

            Loaded += async (s, e) =>
            {
                await LoadHistory();
                (App.Current.MainWindow as MainWindow)?.AutoHeightAdjust(minHeight: MIN_HEIGHT, maxHeight: MIN_HEIGHT);
                Translator.TranslationLogged += OnTranslationLogged;
            };
            Unloaded += (s, e) =>
            {
                HistoryDataGrid.ItemsSource = null;
                Translator.TranslationLogged -= OnTranslationLogged;
            };

            HistoryMaxRow.SelectionChanged += maxRow_SelectionChanged;
        }
        private RenderTargetBitmap CreateTestImage()
        {
            Grid grid = new Grid
            {
                Width = 150,
                Height = 80,
                Background = Brushes.LightBlue
            };

            TextBlock text = new TextBlock
            {
                Text = "TEST IMAGE",
                FontSize = 20,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };

            grid.Children.Add(text);

            grid.Measure(
                new Size(
                    grid.Width,
                    grid.Height
                )
            );

            grid.Arrange(
                new Rect(
                    0,
                    0,
                    grid.Width,
                    grid.Height
                )
            );

            RenderTargetBitmap bitmap =
                new RenderTargetBitmap(
                    (int)grid.Width,
                    (int)grid.Height,
                    96,
                    96,
                    PixelFormats.Pbgra32
                );

            bitmap.Render(grid);

            return bitmap;
        }

        private void Cell_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            try
            {
                if (sender is not Border border)
                    return;

                if (border.DataContext is not TranslationHistoryEntry entry)
                    return;

                string text =
                    $"{entry.ContextText}\n\n{entry.SourceText}";

                RenderTargetBitmap combined =
                    CreateClipboardCard(text);

                Clipboard.SetImage(combined);

                SnackbarHost.Show(
                    "Copied",
                    "Image with text copied",
                    SnackbarType.Success,
                    1000
                );
            }
            catch (Exception ex)
            {
                SnackbarHost.Show(
                    "Error",
                    ex.Message,
                    SnackbarType.Error,
                    3000
                );
            }
        }

        private RenderTargetBitmap CreateClipboardCard(string text)
        {
            Grid container = new Grid
            {
                Width = 800,
                Height = 500,
                Background = Brushes.White
            };

            container.RowDefinitions.Add(
                new RowDefinition
                {
                    Height = new GridLength(250)
                });

            container.RowDefinitions.Add(
                new RowDefinition()
            );

            // image area
            Border image = new Border
            {
                Background = Brushes.LightBlue,
                Margin = new Thickness(20)
            };

            TextBlock imageText = new TextBlock
            {
                Text = "SCREENSHOT",
                FontSize = 24,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };

            image.Child = imageText;

            Grid.SetRow(image, 0);

            // text area
            TextBlock content = new TextBlock
            {
                Margin = new Thickness(20),
                Text = text,
                FontSize = 18,
                TextWrapping = TextWrapping.Wrap
            };

            Grid.SetRow(content, 1);

            container.Children.Add(image);
            container.Children.Add(content);

            container.Measure(
                new Size(
                    container.Width,
                    container.Height));

            container.Arrange(
                new Rect(
                    0,
                    0,
                    container.Width,
                    container.Height));

            RenderTargetBitmap bitmap =
                new RenderTargetBitmap(
                    800,
                    500,
                    96,
                    96,
                    PixelFormats.Pbgra32);

            bitmap.Render(container);

            return bitmap;
        }
        private async void OnTranslationLogged()
        {
            await LoadHistory();
        }

        private async void PageDown_click(object sender, RoutedEventArgs e)
        {
            if (currentPage - 1 >= 1)
                currentPage--;
            await LoadHistory();
        }

        private async void PageUp_click(object sender, RoutedEventArgs e)
        {
            if (currentPage < maxPage)
                currentPage++;
            await LoadHistory();
        }

        private async void Delete_click(object sender, RoutedEventArgs e)
        {
            var dialogHostContainer = (Application.Current.MainWindow as MainWindow)?.DialogHostContainer;

            var dialog = new ContentDialog
            {
                Title = new TextBlock
                {
                    Text = "Do you want to delete all history?",
                    FontSize = 18,
                    FontWeight = FontWeights.Regular
                },
                Content = "This operation cannot be undone!",
                PrimaryButtonText = "Yes",
                CloseButtonText = "No",
                DefaultButton = ContentDialogButton.Close,
                DialogHost = dialogHostContainer,
                Padding = new Thickness(8, 4, 8, 8),
            };

            dialogHostContainer.Visibility = Visibility.Visible;
            var result = await dialog.ShowAsync();
            dialogHostContainer.Visibility = Visibility.Collapsed;

            if (result == ContentDialogResult.Primary)
            {
                currentPage = 1;
                await SQLiteHistoryLogger.ClearHistory();
                await LoadHistory();
            }
        }

        private async void maxRow_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            string tag = (e.AddedItems[0] as ComboBoxItem).Tag as string;
            maxRowPerPage = Convert.ToInt32(tag);

            await LoadHistory();

            if (currentPage > maxPage)
            {
                currentPage = maxPage;
                await LoadHistory();
            }
        }

        private async void Refresh_click(object sender, RoutedEventArgs e)
        {
            await LoadHistory();
        }

        private async void Export_click(object sender, RoutedEventArgs e)
        {
            SaveFileDialog saveFileDialog = new SaveFileDialog
            {
                Filter = "CSV (*.csv)|*.csv|All file (*.*)|*.*",
                DefaultExt = ".csv",
                FileName = $"exported_{DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss")}.csv",
                InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
            };

            if (saveFileDialog.ShowDialog() == true)
            {
                try
                {
                    await SQLiteHistoryLogger.ExportToCSV(saveFileDialog.FileName);
                    SnackbarHost.Show("Saved Success.", $"File saved to: {saveFileDialog.FileName}", SnackbarType.Success);
                }
                catch (Exception ex)
                {
                    SnackbarHost.Show("Save Failed.", $"File saved faild:{ex.Message}", SnackbarType.Error);
                }
            }
        }

        private async void HistorySearchBox_QuerySubmitted(AutoSuggestBox sender, AutoSuggestBoxQuerySubmittedEventArgs args)
        {
            string searchText = (sender as AutoSuggestBox)?.Text ?? "";

            // Clear search by Ctrl+A and Delete and Enter
            if (string.IsNullOrEmpty(searchText))
            {
                SearchText = string.Empty;
                currentPage = searchPage;
            }
            else // Submit search
            {
                if (string.IsNullOrEmpty(SearchText))
                {
                    searchPage = currentPage;
                }
                SearchText = (sender as AutoSuggestBox)?.Text;
                currentPage = 1;
            }
            await LoadHistory();
        }

        private async void HistorySearchBox_TextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
        {
            // Press X to clear search box
            if (args.Reason == AutoSuggestionBoxTextChangeReason.ProgrammaticChange)
            {
                if (!string.IsNullOrEmpty(SearchText))
                {
                    SearchText = string.Empty;
                    currentPage = searchPage;
                    await LoadHistory();
                }
            }
        }

        private static T FindVisualChild<T>(DependencyObject parent)
            where T : DependencyObject
        {
            if (parent == null)
                return null;

            for (int i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
            {
                DependencyObject child =
                    VisualTreeHelper.GetChild(parent, i);

                if (child is T typedChild)
                    return typedChild;

                T result = FindVisualChild<T>(child);

                if (result != null)
                    return result;
            }

            return null;
        }

        public async Task LoadHistory()
        {
            var data = await SQLiteHistoryLogger.LoadHistoryAsync(currentPage, maxRowPerPage, SearchText);
            List<TranslationHistoryEntry> history = data.Item1;

            maxPage = (data.Item2 > 0) ? data.Item2 : 1;

            await Dispatcher.InvokeAsync(() =>
            {
                HistoryDataGrid.ItemsSource = history;
                PageNumber.Text = currentPage.ToString() + "/" + maxPage.ToString();
            });
        }
    }
}