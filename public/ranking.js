import { element } from './builder.js'
const body = document.getElementById('ranking')
const state = document.getElementById('ranking-state')
const connection = document.getElementById('connection')
const title = document.getElementById('ranking-title')
let last, roomId, revision
function show(data) {
  if (data.roomId && data.roomId === roomId && data.revision < revision) return
  const key = JSON.stringify(data)
  if (last === key) return
  last = key
  roomId = data.roomId
  revision = data.revision
  state.textContent = data.state === 'FINALIZED' ? 'Đã chốt' : data.state === 'WAITING' ? 'Chưa mở phòng' : 'Tạm tính'
  title.textContent = data.title || 'Bảng điểm trực tiếp'
  body.replaceChildren(...data.teams.map(team => {
    const row = element('tr')
    const group = team.group === 'lecturer' ? 'Giảng viên' : team.group ? 'Nhóm ' + team.group : 'Chưa chọn'
    row.append(element('td', team.rank), element('th', team.name, { scope: 'row' }),
      element('td', group), element('td', team.score + '/' + data.maxPoints))
    return row
  }))
  if (!data.teams.length) {
    const row = element('tr')
    row.append(element('td','Chưa có người chơi',{ colspan:'4' }))
    body.append(row)
  }
}
async function snapshot() {
  try {
    const response = await fetch('/api/ranking')
    if (!response.ok) throw new Error()
    show(await response.json())
    if (fallback) connection.textContent = 'Cập nhật định kỳ'
  } catch { connection.textContent = 'Đang kết nối lại' }
}
let fallback
function pollRanking() {
  if (fallback) return
  fallback = setInterval(snapshot, 2000)
  snapshot()
}
if (location.hostname.endsWith('.trycloudflare.com')) {
  pollRanking()
} else {
  const events = new EventSource('/api/ranking/events')
  events.addEventListener('ranking', event => {
    clearInterval(fallback)
    fallback = undefined
    connection.textContent = 'Trực tiếp'
    show(JSON.parse(event.data))
  })
  events.addEventListener('error', () => {
    connection.textContent = 'Đang kết nối lại'
    pollRanking()
  })
}
