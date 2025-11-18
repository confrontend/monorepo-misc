import csv
import requests
import time

def fetch_pages_and_write(per_page=100):
    page = 1

    # Create the file and write the header immediately
    with open('advisor_articles.csv', 'w', newline='', encoding='utf-8', buffering=1) as f:
        writer = csv.writer(f)
        writer.writerow(['id', 'date', 'title', 'url', 'author', 'categories'])
        f.flush()
        print("📄 Created advisor_articles.csv and wrote header.")

    print("\n🔍 Starting to fetch and fill file LIVE...\n")

    # Now append rows page by page
    while True:
        url = f"https://www.advisor.ca/wp-json/wp/v2/posts?per_page={per_page}&page={page}"
        print(f"➡️ Fetching page {page} ...")

        response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
        if response.status_code != 200:
            print(f"❌ HTTP {response.status_code}, stopping.")
            break

        posts = response.json()
        if not posts:
            print("⛔ No more posts found.")
            break

        # Append rows LIVE
        with open('advisor_articles.csv', 'a', newline='', encoding='utf-8', buffering=1) as f:
            writer = csv.writer(f)

            for p in posts:
                writer.writerow([
                    p['id'],
                    p['date'],
                    p['title']['rendered'],
                    p['link'],
                    p['author'],
                    p['categories']
                ])
                f.flush()  # 👈 makes the file update instantly

        print(f"   ✔ Added {len(posts)} posts from page {page}")

        page += 1
        time.sleep(0.1)  # optional slow-down so you can watch it fill

    print("\n🎉 Done filling advisor_articles.csv")


fetch_pages_and_write(per_page=100)
