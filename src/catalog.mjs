export const revision = '1be4637e20241054e23b99c8e2412fd2e7cbbc68'
export const packVersion = 'eshop-1be4637-v2'
const actor = {label:'Tài khoản fixture', type:'enum', values:['alice','bob','admin']}
const text = label => ({label,type:'string'})
const integer = label => ({label,type:'integer'})
const decimal = label => ({label,type:'number'})
const status = {'status':'integer'}
const message = {...status,'body.message':'string','body.error':'string'}
export const operations = {
  cart:{label:'Đọc giỏ hàng', args:[actor], output:{...status,'body.length':'integer','body[0].id':'integer','body[0].quantity':'integer','body[0].price':'number'}},
  addItem:{label:'Thêm sản phẩm vào giỏ', args:[actor,integer('ID sản phẩm'),integer('Số lượng'),decimal('Đơn giá')], output:message},
  checkout:{label:'Tạo đơn hàng', args:[actor,decimal('Tổng tiền'),text('Địa chỉ giao')], output:{...message,'body.orderId':'integer'}},
  orders:{label:'Danh sách đơn của tài khoản', args:[actor], output:{...status,'body.length':'integer','body[0].id':'integer','body[0].status':'orderStatus'}},
  cancel:{label:'Hủy đơn hàng', args:[actor,integer('ID đơn hàng')], output:message},
  order:{label:'Đọc chi tiết đơn hàng', args:[integer('ID đơn hàng')], output:{...message,'body.id':'integer','body.user_id':'integer','body.total_amount':'number','body.status':'orderStatus'}},
  couponList:{label:'Đọc danh sách mã', args:[actor], output:{...status,'body.length':'integer','body[0].id':'integer','body[0].code':'string','body[0].max_uses_per_user':'integer'}},
  createCoupon:{label:'Tạo mã giảm giá', args:[actor,text('Mã'),{label:'Loại giảm',type:'enum',values:['fixed','percent']},decimal('Giá trị giảm'),decimal('Tổng tối thiểu'),integer('Phút hết hạn tính từ mốc fixture'),integer('Số lượt mỗi tài khoản')], output:{...message,'body.id':'integer'}},
  applyCoupon:{label:'Thử áp dụng mã', args:[text('Mã'),decimal('Giá trị đơn'),{...actor,values:[...actor.values,'guest']}], output:{...message,'body.success':'boolean','body.coupon_id':'integer','body.discount_amount':'number','body.final_amount':'number'}},
  recordCoupon:{label:'Ghi nhận đã dùng mã', args:[actor,integer('ID mã giảm giá')], output:message},
  login:{label:'Đăng nhập fixture', args:[actor,text('Mật khẩu')], output:{...message,'body.user.id':'integer','body.user.role':'string'}},
  profile:{label:'Đọc hồ sơ fixture', args:[actor], output:{...status,'body.id':'integer','body.name':'string','body.role':'string','body.login_attempts':'integer'}},
  setClock:{label:'Đặt đồng hồ fixture', args:[integer('Phút tính từ mốc fixture')], output:{...status,'body.minute':'integer'}}
}
export const enums = {orderStatus:['pending','confirmed','shipped','delivered','canceled']}
export const fixture = {
  start: '2026-10-22T12:00:00.000Z',
  accounts: {alice:{email:'alice@activity.invalid',password:'AliceFixture7'}, bob:{email:'bob@activity.invalid',password:'BobFixture7'}, admin:{email:'admin@eshop.com',password:'Admin123!'}},
  coupon: {code:'LABFIXED',min:200000,discount:35000,expiryMinute:6,maxUses:2},
  bobLockMinute:4
}
export const scenarios = {
  standard: {label:'Ca chuẩn',bobLockMinute:4,expiryMinute:6,maxUses:2},
  extended: {label:'Ca kéo dài',bobLockMinute:8,expiryMinute:11,maxUses:3},
  short: {label:'Ca sát biên',bobLockMinute:1,expiryMinute:2,maxUses:1}
}
export const problems = [
  {id:'orders', title:'Cart and Order Integrity', level:'Nâng cao', domain:'cart-orders', minScore:2, ranges:[[284,349]], mutants:['orders-4','orders-68'], files:['test/cart-orders.test.js'],
    intro:'Kiểm tra tính toàn vẹn của dữ liệu qua nhiều lần gọi và nhiều tài khoản.',
    rules:[
      'Giỏ của mỗi tài khoản bắt đầu rỗng. Thêm sản phẩm lưu đúng dữ liệu và thứ tự; đọc giỏ không làm mất dữ liệu.',
      'Checkout tạo một đơn pending. Chủ đơn có thể hủy đơn pending. Đọc lại chi tiết phải phản ánh trạng thái đã lưu.',
      'Mỗi test dùng dữ liệu mới, với hai khách và một quản trị viên fixture.'
    ]},
  {id:'coupons', title:'Coupon Lifecycle', level:'Nâng cao', domain:'coupons', minScore:2, ranges:[[356,482]], mutants:['coupons-33','coupons-113'], files:['test/coupons.test.js','test/coupons-flow.test.js'],
    intro:'Theo dõi cấu hình, thời hạn và lịch sử sử dụng của cùng một mã.',
    rules:[
      'Mã fixture LABFIXED giảm cố định 35.000 trên đơn thỏa ngưỡng 200.000. Dùng giá trị đơn lớn hơn ngưỡng trong đề này.',
      'Mã hợp lệ đến và gồm thời điểm hết hạn. Sau thời điểm đó hệ thống từ chối.',
      'Số lượt của mã mới tuân theo giá trị cấu hình. Thử áp dụng chỉ tính giá. Lời gọi ghi nhận mới tăng số lượt đã dùng.'
    ]},
  {id:'auth', title:'Account Recovery at the Lock Boundary', level:'Nâng cao', domain:'auth', minScore:1, ranges:[[32,67],[112,117]], mutants:['auth-32'], files:['test/auth.spec.test.js'],
    intro:'Kiểm tra đồng hồ, trạng thái khóa và độc lập giữa tài khoản.',
    rules:[
      'Một tài khoản đang khóa từ chối đăng nhập nếu đồng hồ còn trước thời điểm hết khóa, kể cả với mật khẩu đúng.',
      'Từ thời điểm hết khóa, tài khoản được đánh giá lại theo thông tin đăng nhập. Alice không bị khóa. Xem thời điểm hết khóa của Bob trong dữ liệu kịch bản đã chọn.',
      'Đồng hồ là phút tính từ mốc fixture, đặt lại về 0 cho từng test. Mật khẩu dưới đây chỉ dành cho fixture.'
    ]}
]
