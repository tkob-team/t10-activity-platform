# T10 Mutation Lab

Một activity EShop gồm Cart and Orders, Coupons và Auth với cùng bảng điểm. Nộp bài lấy nội dung từ tab Dựng test hoặc Viết code đang mở. Máy chấm tự kiểm tra original trước khi chạy biến thể.

Pool hiện tại có 69 mutant có đối chứng trong 81 ứng viên. Mỗi mutant phát hiện lần đầu cộng 1 điểm. Điểm hiện tại và điểm tối đa hiển thị cạnh nút nộp và trong bảng xếp hạng.

## Run locally

Yêu cầu Git, Node.js 24.16, Docker Desktop với Linux containers và hai repo EShop/tài liệu nằm cạnh repo này. Tạo pack riêng từ source revision và báo cáo audit.

```powershell
npm.cmd run setup
npm.cmd run prepare:sut
docker compose up -d --build --wait
```

- Participant mặc định: http://127.0.0.1:8787 hoặc http://localhost:8787. Xem `LAB_PUBLIC_PORT` nếu cấu hình cổng khác.
- Host Console mặc định: http://127.0.0.1:8788. Xem `LAB_ADMIN_PORT` nếu cấu hình cổng khác.
- Projector: đường dẫn `/projector` trên Participant.

Mở Host Console trên máy chạy Docker, đặt tên và mở phòng. Cổng local tự dùng `LAB_ADMIN_KEY` từ `.env` ở phía máy chủ. Khi phòng mở, người có link Participant nhập tên hiển thị và chọn nhóm. Bảng xếp hạng hiển thị nhóm đã chọn. Pack và `.env` nằm ngoài Git. Dừng bằng `docker compose stop` để giữ DB và phòng.

Chọn **Dọn phiên để mở mới** và xác nhận để dừng chấm phiên hiện tại. Bảng điểm, danh sách người tham gia và phiên đăng nhập của phòng cũ tách khỏi phòng mới. Dùng **Tải báo cáo phiên trước** để tải bản đã lưu, rồi đặt tên và bấm **Mở phòng**.

Host Console có thống kê phòng, bảng người tham gia, lịch sử và chi tiết bài nộp. Chọn tên người tham gia để xem bài gần nhất, tiến độ chấm mutant và 12 lượt chạy gần đây. Nếu mất phiên, mở chi tiết người tham gia, cấp liên kết vào lại và gửi riêng trong vòng 10 phút. Dùng `LAB_PUBLIC_ORIGIN` bằng URL thực tế khi cấp liên kết cho thiết bị khác. Bản nháp chưa nộp lưu trong trình duyệt đã soạn.

## Design

Web nhận và trả receipt sau khi commit bài nộp. Scheduler claim task từ PostgreSQL và chuyển tới executor nội bộ. Executor spawn Node child riêng cho original hoặc từng mutant, tạo SQLite in-memory cho từng test và trả evidence có outcome, assertion, exit code và thời gian chạy. Scheduler chấm lại lỗi tạm thời tối đa hai lần thực thi tổng cộng. Fence và lease ngăn ghi lại từ attempt cũ. Điểm là tập unique kills của người/đội trên toàn pack. Bảng điểm cập nhật bằng SSE kèm REST fallback.

TypeScript ở lớp web, scheduler và executor chạy bằng Node type stripping. Catalog, parser và adapter EShop kế thừa hành vi đã kiểm tra từ commit `2e43a56`. App mới dùng migration PostgreSQL, job, report và UI mới.

## Qualification

```powershell
docker compose run --rm --no-deps executor npm test
```

HTTP integration sử dụng Compose project riêng. Script chủ động dừng scheduler và tạo dữ liệu mô phỏng, chỉ chạy trên project test.

```powershell
$env:LAB_PUBLIC_PORT='19787'
$env:LAB_ADMIN_PORT='19788'
$env:LAB_TEST_PUBLIC='http://127.0.0.1:19787'
$env:LAB_TEST_HOST='http://127.0.0.1:19788'
docker compose -p t10-lab-check up -d --no-build --wait
node --env-file=.env test/http.integration.mjs
```

## Deploy and recover

Chỉ đưa Participant qua URL lớp. Giữ Host Console bind loopback. Nếu dùng HTTPS tunnel, đặt `LAB_PUBLIC_ORIGIN` bằng origin HTTPS chính xác. Link public và địa chỉ local đều gửi bài được vào cùng database. Cookie gắn theo hostname. Kiểm tra cookies, truy cập từ mạng lớp và tải trước khi mở phòng. Ghim pack và lưu bản export trước khi thay cấu hình.

```powershell
node scripts/backup.mjs save .runtime/pilot-backup
docker compose -p t10-lab-restore up -d --wait db
node scripts/backup.mjs restore .runtime/pilot-backup --project t10-lab-restore
```

Restore yêu cầu DB đích trống và pack mount có hash khớp manifest. Dùng cổng khác nếu bật web của project phục hồi. Giữ bản sao chứa submissions ở thư mục riêng của điều phối viên. Dữ liệu dự phòng local phục vụ rehearsal và recovery.
