import json
import os
import secrets
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="t10-browser-") as temp:
    key = secrets.token_urlsafe(32)
    env = {**os.environ, "NODE_ENV": "development", "APP_ORIGIN": "", "PORT": "0", "ADMIN_PORT": "0",
           "ACTIVITY_DB": str(Path(temp) / "activity.sqlite"), "ADMIN_KEY": key, "JOIN_CODE": ""}
    server = subprocess.Popen(["node", "src/server.mjs"], cwd=ROOT, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    try:
        public = server.stdout.readline().strip().removeprefix("Activity: ")
        admin = server.stdout.readline().strip().removeprefix("Operator: ")
        assert public.startswith("http://127.0.0.1:") and admin.startswith("http://127.0.0.1:"), server.stderr.read()
        with urllib.request.urlopen(urllib.request.Request(admin + "/api/admin/room", method="POST",
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            data=json.dumps({"action": "open"}).encode())) as response:
            assert response.status == 200
        with sync_playwright() as browser_api:
            browser = browser_api.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1366, "height": 850})
            page = context.new_page()
            failures = []
            page.on("pageerror", lambda error: failures.append(str(error)))
            page.goto(public)
            page.get_by_text("Đang nhận bài", exact=True).wait_for()
            page.get_by_role("radio", name="Nhóm", exact=True).check()
            page.get_by_label("Tên hiển thị").fill("Đội Playwright")
            page.get_by_role("button", name="Vào phòng thi").click()
            expect(page.get_by_role("heading", name="Cart and Order Integrity")).to_be_visible()
            page.get_by_role("button", name="Đã lưu").click()
            page.get_by_role("button", name="Source", exact=True).click()
            expect(page.locator("#docs pre").first).to_contain_text("app.get")
            page.get_by_role("button", name="Tests có sẵn").click()
            expect(page.locator("#docs pre").first).to_contain_text("test(")
            page.get_by_role("button", name="Thêm test").click()
            page.get_by_role("button", name="+ Lời gọi", exact=True).click()
            page.get_by_label("Hàm cần gọi").select_option("cart")
            page.get_by_label("Tài khoản fixture").select_option("alice")
            page.get_by_role("button", name="+ Kiểm tra", exact=True).click()
            page.get_by_label("Kết quả cần kiểm tra").select_option("r1.body.length")
            page.get_by_label("Giá trị mong đợi").fill("0")
            page.get_by_role("tab", name="Viết code").click()
            code = ("test('retains items', async () => { await sut.addItem('alice',7,2,50000); "
                    "const first = await sut.cart('alice'); const second = await sut.cart('alice'); "
                    "expect(first.body[0].quantity).toBe(2); expect(second.body.length).toBe(1); })")
            page.get_by_label("Code test của đội").fill(code)
            page.get_by_role("tab", name="Dựng test").click()
            expect(page.get_by_label("Giá trị mong đợi")).to_have_value("0")
            page.get_by_role("tab", name="Viết code").click()
            expect(page.get_by_label("Code test của đội")).to_have_value(code)
            page.get_by_role("button", name="Nộp bộ test").click()
            expect(page.locator("#result")).to_contain_text("+1 điểm", timeout=20000)
            page.get_by_role("button", name="Bảng xếp hạng").click()
            expect(page.get_by_role("row").filter(has_text="Đội Playwright")).to_contain_text("1/2")
            page.reload()
            expect(page.get_by_role("heading", name="Cart and Order Integrity")).to_be_visible()
            expect(page.get_by_label("Code test của đội")).to_have_value(code)
            expect(page.get_by_text("Nhóm / Đội Playwright")).to_be_visible()
            mobile = browser.new_page(viewport={"width": 390,"height": 844})
            mobile.goto(public)
            mobile.get_by_text("Đang nhận bài", exact=True).wait_for()
            mobile.get_by_role("radio", name="Cá nhân", exact=True).check()
            mobile.get_by_label("Tên hiển thị").fill("Người chơi mobile")
            mobile.get_by_role("button", name="Vào phòng thi").click()
            expect(mobile.get_by_role("heading", name="Coupon Lifecycle")).to_be_visible()
            assert mobile.locator("html").evaluate("(element) => element.scrollWidth <= innerWidth")
            assert not failures, failures
            browser.close()
        print("PASS: Chromium desktop and mobile, join/assignment, typed builder, code drafts, mixed grading, leaderboard and reload.")
    finally:
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=8)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
