# T10 Mutation Lab

Activity phòng thi cho CSC13003. Người chơi vào bằng tên cá nhân hoặc nhóm, nhận đề mở đầu, đọc source và starter tests, soạn test bằng builder hoặc code, rồi xem điểm. Cả ba đề dùng chung gói EShop đã audit ở commit 1be4637e20241054e23b99c8e2412fd2e7cbbc68.

## Run Locally

Yêu cầu Node.js 24.11 trở lên trong dòng 24, npm và hai repo seminar/source nằm cạnh repo platform. Lệnh chuẩn bị đọc đúng revision từ Git và nhập các mutant Survived hoặc NoCoverage trong phạm vi API từng vòng từ report audit. Có thể đổi vị trí qua SUT_REPO và SUT_EVIDENCE. Gói mới nằm trong .runtime/eshop/pack-v2.json. Máy chủ lưu bản ghim theo SHA-256 trong .runtime/eshop/packs. Đây là dữ liệu riêng của máy chấm.

~~~powershell
npm.cmd ci
npm.cmd run prepare:sut
npm.cmd start
~~~

Terminal in địa chỉ người chơi, địa chỉ điều phối và khóa điều phối tạm nếu ADMIN_KEY chưa được cấu hình. Mở trang điều phối trên chính máy chạy, nhập khóa, bấm Mở phòng. Trang người chơi mặc định ở http://127.0.0.1:8787. Điều phối mặc định ở http://127.0.0.1:8788.

Điểm, phiên và lượt nộp lưu trong data/activity.sqlite. Người chơi tiếp tục bằng cookie HttpOnly khi tải lại trên cùng trình duyệt và địa chỉ web. Bản nháp và vòng đang mở lưu trên trình duyệt. Khi restart, lượt đang chạy trở về hàng đợi với đúng pack đã ghim. Để dùng gói V2, dừng process cũ trước khi khởi động lại. Phòng cũ đã có người chơi tiếp tục dùng gói cũ. Đóng nhận bài, đợi queue hoàn tất rồi tạo phòng mới để dùng gói V2.

## Grading Contract

- Cart and Order Integrity kiểm tra tính toàn vẹn qua nhiều lần đọc và trạng thái đơn sau thao tác.
- Coupon Lifecycle kiểm tra thời hạn đúng biên và lượt sử dụng được cấu hình qua nhiều yêu cầu.
- Account Recovery at the Lock Boundary kiểm tra đồng hồ, trạng thái khóa và độc lập giữa tài khoản.
- Ngưỡng qua vòng là Cart & Orders 2, Coupons 2 và Auth 1 điểm. Một mutant bị bắt bằng assertion có giá trị 1 điểm, tính một lần cho mỗi người chơi hoặc nhóm. Điểm vượt ngưỡng được cộng vào tổng xếp hạng. Cùng tổng điểm thì đồng hạng.
- Gói V2 nhập 81 mutant từ audit gồm 23 Cart & Orders, 51 Coupons và 7 Auth. Ngân hàng mở rộng vượt bộ 5 mutant cũ. Mutant phải có trong gói máy chấm của phòng thì máy mới có biến thể để chạy.
- Máy chấm chạy bộ test đã gửi trên code gốc trước. Khi tất cả pass, máy chạy các mutant chưa được ghi điểm của vòng. Assertion fail dừng test case tại bước đó. Timeout hoặc lỗi chạy không tự tạo điểm.
- Mỗi test chọn một kịch bản dữ liệu. Người chơi vẫn tự chọn input, gọi API tạo trạng thái và đặt đồng hồ. Chạy thử riêng trên bản gốc hiển thị output trong đúng khung test và có quota riêng. Lịch sử giữ snapshot của từng lượt.
- Source và vị trí mutant lấy từ revision đã audit. Lockfile dùng body-parser 2.4.0. Lượt build gói V2 chuẩn bị các biến thể để chạy, chưa xác nhận khả năng kill hoặc thời lượng chấm của toàn bộ ngân hàng.
- Builder và editor tạo cùng bộ bước có kiểu. Editor nhận cú pháp test/it, const, await sut.hàm, truy cập giá trị kết quả và matcher hỗ trợ. Parser không thực thi JavaScript do người chơi gửi. Phần API của đề liệt kê phương thức và tham số.
- Dữ liệu fixture là tổng hợp. Các endpoint EShop gốc chỉ hoạt động sau adapter nội bộ, trong tiến trình chấm với DB SQLite in-memory. Session, score và DB platform tách riêng. Lỗi chạy và timeout không cộng điểm.

## Manual Review

1. Dừng process cũ, chạy npm.cmd start rồi mở phòng V2 từ trang điều phối.
2. Vào bằng tên, mở một vòng, tạo hai test với kịch bản khác nhau rồi tải lại trang. Kiểm tra phiên, vòng đang mở và nháp.
3. Bấm Chạy thử test này, xem output bên dưới input và assertion trong cùng khung. Thử chèn bước, đổi thứ tự và xóa một lời gọi đang được tham chiếu.
4. Nộp một bộ test, kiểm tra pass hoặc fail trên bản gốc, điểm vòng, ngưỡng qua và tổng ranking. Bắt thêm mutant sau khi qua ngưỡng để kiểm tra điểm cộng. Nộp lại không cộng trùng.
5. Mở lại lượt trong lịch sử và đổi đề khi có job đang chạy. Kiểm tra đúng vòng, snapshot và output.
6. Trên trang điều phối, xem trạng thái queue và xuất kết quả để đối chiếu từng lượt hoặc chọn test cho peer review.

Các script kiểm chứng tự động cũ thuộc bản 5 mutant và luồng mã khôi phục V1. Review V2 theo các bước trên. Batch tự động V2 chưa được chạy.

## Production Runbook

1. Cài dependencies, tạo gói SUT, chạy batch kiểm chứng trên đúng máy chấm. Khi chuyển host, sao chép gói riêng vào thư mục chỉ người vận hành đọc được và trỏ SUT_PACK_FILE đến gói đó.
2. Sao chép ops/production.env.example thành .env local. Đặt APP_ORIGIN đúng hostname HTTPS, ADMIN_KEY ngẫu nhiên tối thiểu 32 ký tự và JOIN_CODE riêng nếu muốn giới hạn vào lớp. Lưu ngoài Git. Chỉ bật TRUST_TUNNEL khi dịch vụ được truy cập qua cloudflared cục bộ tin cậy.
3. Khởi động bằng node --env-file=.env src/server.mjs. Cấu hình Cloudflare Tunnel chỉ đưa cổng web 8787 ra HTTPS. Giữ cổng 8788 cục bộ. Dùng tên miền ổn định cho buổi thi. TryCloudflare phù hợp thử tạm thời và hostname có thể đổi.
4. Trên Cloudflare, bật lớp DDoS phù hợp và cấu hình WAF/rate limit cho các đường dẫn /api/join, /api/recover và /api/jobs. Hiệu chỉnh theo số nhóm và mạng dùng chung của lớp. Hạn chế origin công khai ngoài tunnel. App đã giới hạn kết nối, request burst, payload, lượt nộp theo phiên, queue và thời gian chạy. Các giới hạn này giảm tải tại app và không thay thế bảo vệ lưu lượng từ mạng biên.
5. Truy cập URL HTTPS từ thiết bị khác, thử vào phòng, nộp bài, cookie Secure, phân đề và bảng điểm. Pilot đồng thời theo số đội dự kiến. Thử ngắt kết nối, nộp lại, restart và phương án offline trước khi mở cho cả lớp.
6. Trong buổi thi, mở phòng từ trang điều phối và theo dõi queue. Khi hết giờ, đóng nhận bài, đợi queue kết thúc rồi xuất JSON. Giữ khóa admin riêng. Chỉ chia sẻ tên hiển thị và tally khi cần.
7. Sao lưu bằng node scripts/backup.mjs data/activity.sqlite data/activity-backup.sqlite với tên đích mới. Để phục hồi, dừng app, giữ DB hiện tại riêng và khởi động với ACTIVITY_DB trỏ đến bản sao đã xác minh. Giữ cả thư mục packs và gói gốc của phòng khi sao lưu hoặc phục hồi.

Cloudflare guides for [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [named Tunnel](https://developers.cloudflare.com/tunnel/get-started/) and [DDoS protection](https://developers.cloudflare.com/ddos-protection/).

## Classroom Flow

Mở đầu bằng ví dụ ngoài bộ đề chấm. Các đội chọn cá nhân hoặc nhóm, đọc quy tắc, soạn test và nộp. Sau vòng làm bài, hai đội trao đổi một test để giải thích vì sao input và assertion phát hiện được mutant. Người điều phối chốt tally, minh họa đáp án và thu minute paper. Giới hạn 20 phút là tiêu chí pilot, không phải kết quả đã đo.

Code và lịch sử lượt nộp không được công khai giữa các đội. Builder hỗ trợ chọn giá trị có kiểu và tham chiếu kết quả trước. UI không công bố ID mutant, patch hoặc đáp án trong vòng thi. Không dùng AI để chấm hay suy đoán ai dùng AI. Quy định của lớp và phần giải thích trực tiếp vẫn cần người điều phối.

## Current Limits

Bản này dùng một web process và SQLite local, phù hợp với một buổi seminar được pilot trên máy thật. Editor hỗ trợ tập con JavaScript có cấu trúc. Người chơi không chạy Jest đầy đủ, import thư viện hoặc dùng vòng lặp. Khi cần đổi gói đề hay runtime, tạo phiên mới sau khi chạy lại đối chứng.
