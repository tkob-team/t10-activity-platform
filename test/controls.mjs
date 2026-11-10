const test = (name, body) => 'test(' + JSON.stringify(name) + ', async () => {' + body + '})'

const cases = [
  ['orders-3 orders-5 orders-6', test('New cart is empty', `
    const empty = await sut.cart('alice');
    expect(empty.status).toBe(200);
    expect(empty.body.length).toBe(0);
  `)],
  ['orders-4 orders-12 orders-14 orders-15 orders-17 orders-18', test('Cart additions persist across reads', `
    const added = await sut.addItem('alice',7,2,50000);
    expect(added.body.message).toContain('Added to cart');
    await sut.addItem('alice',8,3,10000);
    const first = await sut.cart('alice');
    const again = await sut.cart('alice');
    expect(first.body.length).toBe(2);
    expect(first.body[0].quantity).toBe(2);
    expect(again.body[1].quantity).toBe(3);
  `)],
  ['orders-32 orders-38', test('Checkout confirms the order and adds it to its owner list', `
    const created = await sut.checkout('alice',200000,'Fixture street');
    expect(created.body.message).toContain('Checkout successful');
    const list = await sut.orders('alice');
    expect(list.body[0].id).toBe(created.body.orderId);
    expect(list.body[0].status).toBe('pending');
  `)],
  ['orders-51 orders-52', test('Another account cannot cancel the order', `
    const created = await sut.checkout('alice',200000,'Fixture street');
    const blocked = await sut.cancel('bob',created.body.orderId);
    expect(blocked.status).toBe(404);
    expect(blocked.body.error).toContain('Order not found');
  `)],
  ['orders-63 orders-64 orders-67 orders-68 orders-71 orders-72', test('Cancellation persists and cannot be repeated', `
    const created = await sut.checkout('alice',200000,'Fixture street');
    const updated = await sut.cancel('alice',created.body.orderId);
    expect(updated.status).toBe(200);
    expect(updated.body.message).toContain('Order canceled successfully');
    const order = await sut.order(created.body.orderId);
    expect(order.body.status).toBe('canceled');
    const repeated = await sut.cancel('alice',created.body.orderId);
    expect(repeated.status).toBe(400);
    expect(repeated.body.error).toContain('Cannot cancel');
  `)],
  ['orders-83 orders-84', test('Missing order detail returns a useful error', `
    const result = await sut.order(999999);
    expect(result.status).toBe(404);
    expect(result.body.error).toContain('Order not found');
  `)],
  ['coupons-14 coupons-15', test('Empty coupon code is rejected', `
    const result = await sut.applyCoupon('',300000,'alice');
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('nhập mã giảm giá');
  `)],
  ['coupons-24 coupons-25', test('Unknown coupon code is rejected', `
    const result = await sut.applyCoupon('UNKNOWNLAB',300000,'alice');
    expect(result.status).toBe(404);
    expect(result.body.error).toContain('không tồn tại');
  `)],
  ['coupons-33 coupons-36 coupons-37', test('Coupon is valid at expiry and rejected afterward', `
    await sut.setClock(6);
    const at = await sut.applyCoupon('LABFIXED',250000,'alice');
    expect(at.status).toBe(200);
    expect(at.body.discount_amount).toBe(35000);
    await sut.setClock(7);
    const after = await sut.applyCoupon('LABFIXED',250000,'alice');
    expect(after.status).toBe(400);
    expect(after.body.error).toContain('hết hạn');
  `)],
  ['coupons-63 coupons-64 coupons-66 coupons-69', test('Fixed coupon for signed-in account', `
    const result = await sut.applyCoupon('LABFIXED',300000,'alice');
    expect(result.body.discount_amount).toBe(35000);
    expect(result.body.final_amount).toBe(265000);
    expect(result.body.message).toContain('Áp dụng thành công');
    expect(result.body.message).toContain('₫');
  `)],
  ['coupons-71 coupons-73 coupons-78 coupons-79 coupons-81 coupons-82 coupons-83 coupons-85 coupons-88', test('Fixed coupon for guest', `
    const result = await sut.applyCoupon('LABFIXED',300000,'guest');
    expect(result.body.success).toBe(true);
    expect(result.body.discount_amount).toBe(35000);
    expect(result.body.final_amount).toBe(265000);
    expect(result.body.message).toContain('Áp dụng thành công');
    expect(result.body.message).toContain('₫');
  `)],
  ['coupons-53 coupons-55 coupons-56 coupons-57 coupons-58 coupons-65 coupons-67 coupons-68', test('Half-price coupon for signed-in account', `
    await sut.createCoupon('admin','HALF','percent',0.5,200000,10,2);
    const result = await sut.applyCoupon('HALF',300000,'alice');
    expect(result.body.discount_amount).toBe(150000);
    expect(result.body.final_amount).toBe(150000);
    expect(result.body.message).toContain('%');
  `)],
  ['coupons-72 coupons-74 coupons-75 coupons-76 coupons-77 coupons-84 coupons-86 coupons-87', test('Half-price coupon for guest', `
    await sut.createCoupon('admin','HALF','percent',0.5,200000,10,2);
    const result = await sut.applyCoupon('HALF',300000,'guest');
    expect(result.body.discount_amount).toBe(150000);
    expect(result.body.final_amount).toBe(150000);
    expect(result.body.message).toContain('%');
  `)],
  ['coupons-91', test('Order below minimum is rejected', `
    const result = await sut.applyCoupon('LABFIXED',199999,'alice');
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('giá trị tối thiểu');
  `)],
  ['coupons-50 coupons-51 coupons-103 coupons-104 coupons-111 coupons-113 coupons-120', test('Configured coupon usage is recorded and enforced', `
    const created = await sut.createCoupon('admin','ROOMFIXED','fixed',25000,200000,10,3);
    expect(created.status).toBe(200);
    expect(created.body.message).toContain('Coupon created');
    const first = await sut.applyCoupon('ROOMFIXED',250000,'alice');
    expect(first.status).toBe(200);
    const usage = await sut.recordCoupon('alice',first.body.coupon_id);
    expect(usage.body.message).toContain('Usage recorded');
    await sut.recordCoupon('alice',first.body.coupon_id);
    const before = await sut.applyCoupon('ROOMFIXED',250000,'alice');
    expect(before.status).toBe(200);
    await sut.recordCoupon('alice',first.body.coupon_id);
    const after = await sut.applyCoupon('ROOMFIXED',250000,'alice');
    expect(after.status).toBe(400);
    expect(after.body.error).toContain('đã đạt giới hạn');
  `)],
  ['auth-32 auth-35 auth-36 auth-47', test('Lock boundary and successful login', `
    await sut.setClock(3);
    const before = await sut.login('bob','BobFixture7');
    expect(before.status).toBe(403);
    expect(before.body.error).toContain('khóa');
    const alice = await sut.login('alice','AliceFixture7');
    expect(alice.body.message).toContain('Login successful');
    await sut.setClock(4);
    const at = await sut.login('bob','BobFixture7');
    expect(at.status).toBe(200);
  `)]
]

export const controls = Object.fromEntries(cases.flatMap(([ids,code]) => ids.split(' ').map(id => [id,code])))
export const scoringSuites = ['orders','coupons','auth'].map(feature =>
  cases.filter(([ids])=>ids.startsWith(feature+'-')).map(([,code])=>code).join('\n'))
