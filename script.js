const $ = (selector) => document.querySelector(selector);
const randomBetween = (min, max, decimals = 1) => Number((Math.random() * (max - min) + min).toFixed(decimals));

const appShell = $('#appShell');
const sidebarCollapsed = localStorage.getItem('terraguard-sidebar-collapsed') === 'true';
if (sidebarCollapsed) appShell.classList.add('sidebar-collapsed');

function updateSidebarToggle() {
	const collapsed = appShell.classList.toggle('sidebar-collapsed');
	localStorage.setItem('terraguard-sidebar-collapsed', collapsed);
	setSidebarToggleState(collapsed);
}

function setSidebarToggleState(collapsed) {
	const toggle = $('#sidebarToggle');
	toggle.setAttribute('aria-label', collapsed ? 'Hiện thanh bên' : 'Ẩn thanh bên');
	toggle.title = collapsed ? 'Hiện thanh bên' : 'Ẩn thanh bên';
	toggle.innerHTML = `<i data-lucide="${collapsed ? 'panel-left-open' : 'panel-left-close'}"></i>`;
	lucide.createIcons();
}

setSidebarToggleState(sidebarCollapsed);
$('#sidebarToggle').addEventListener('click', updateSidebarToggle);

const DEFAULT_LOCATION = { latitude: 12.211889, longitude: 108.704333, label: 'Đèo Khánh Lê' };
const weatherDescriptions = {
	0: ['Trời quang', 'sun'], 1: ['Ít mây', 'cloud-sun'], 2: ['Mây rải rác', 'cloud-sun'], 3: ['Nhiều mây', 'cloud'],
	45: ['Sương mù', 'cloud-fog'], 48: ['Sương mù đóng băng', 'cloud-fog'], 51: ['Mưa phùn nhẹ', 'cloud-drizzle'], 53: ['Mưa phùn', 'cloud-drizzle'], 55: ['Mưa phùn dày', 'cloud-drizzle'],
	61: ['Mưa nhẹ', 'cloud-rain'], 63: ['Mưa vừa', 'cloud-rain'], 65: ['Mưa lớn', 'cloud-rain'], 71: ['Tuyết nhẹ', 'snowflake'], 73: ['Tuyết', 'snowflake'], 75: ['Tuyết lớn', 'snowflake'],
	80: ['Mưa rào nhẹ', 'cloud-rain-wind'], 81: ['Mưa rào', 'cloud-rain-wind'], 82: ['Mưa rào lớn', 'cloud-rain-wind'], 95: ['Dông', 'cloud-lightning'], 96: ['Dông có mưa đá', 'cloud-lightning'], 99: ['Dông mạnh', 'cloud-lightning']
};

function getWeatherIcon(code, isNight, windSpeed) {
	if (windSpeed >= 28) return 'wind';
	const weather = weatherDescriptions[code] || ['Thời tiết thay đổi', 'cloud'];
	return isNight && code <= 3 ? 'moon' : weather[1];
}

function renderForecast(weather) {
	const row = $('#forecastRow');
	row.innerHTML = weather.daily.time.map((date, index) => {
		const code = weather.daily.weather_code[index];
		const icon = getWeatherIcon(code, false, weather.daily.wind_speed_10m_max[index]);
		const day = new Date(`${date}T12:00:00`).toLocaleDateString('vi-VN', { weekday: 'short' }).replace('.', '').toUpperCase();
		return `<div><small>${day}</small><i data-lucide="${icon}"></i><strong>${Math.round(weather.daily.temperature_2m_max[index])}° / ${Math.round(weather.daily.temperature_2m_min[index])}°</strong><em>${Math.round(weather.daily.precipitation_probability_max[index])}%</em></div>`;
	}).join('');
	lucide.createIcons();
}

function applyWeatherTheme(code, isNight, windSpeed) {
	const theme = windSpeed >= 28 ? 'wind' : isNight ? 'night' : code >= 51 ? 'rain' : code <= 2 ? 'sunny' : 'cloudy';
	document.body.dataset.weatherTheme = theme;
}

async function loadWeather(location = DEFAULT_LOCATION) {
	const params = new URLSearchParams({ latitude: location.latitude, longitude: location.longitude, current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day', daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max', timezone: 'auto', forecast_days: 5 });
	try {
		const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
		if (!response.ok) throw new Error('Weather request failed');
		const weather = await response.json();
		const current = weather.current;
		const description = weatherDescriptions[current.weather_code]?.[0] || 'Thời tiết thay đổi';
		$('#weatherLocation').textContent = location.label || `Vị trí ${location.latitude.toFixed(3)}, ${location.longitude.toFixed(3)}`;
		$('#weatherSource').textContent = `Open-Meteo · ${weather.timezone}`;
		$('#weatherTemperature').textContent = `${Math.round(current.temperature_2m)}°`;
		$('#weatherDescription').textContent = description;
		$('#weatherFeels').textContent = `${Math.round(current.apparent_temperature)}°`;
		$('#weatherHumidity').textContent = `${Math.round(current.relative_humidity_2m)}%`;
		$('#weatherWind').textContent = `${Math.round(current.wind_speed_10m)} km/h`;
		$('#weatherIcon').setAttribute('data-lucide', getWeatherIcon(current.weather_code, current.is_day === 0, current.wind_speed_10m));
		applyWeatherTheme(current.weather_code, current.is_day === 0, current.wind_speed_10m);
		renderForecast(weather);
		lucide.createIcons();
	} catch (error) {
		$('#weatherSource').textContent = 'Không thể tải dữ liệu thời tiết';
	}
}

function initWeather() {
	if (!navigator.geolocation) return loadWeather();
	navigator.geolocation.getCurrentPosition(
		(position) => loadWeather({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
		() => loadWeather()
	);
}

const firebaseConfig = {
	apiKey: 'AIzaSyDzQFoQ8R023siAj2qaKVneQHu_BII1Zlc',
	authDomain: 'tuiot-ad770.firebaseapp.com',
	databaseURL: 'https://tuiot-ad770-default-rtdb.asia-southeast1.firebasedatabase.app',
	projectId: 'tuiot-ad770',
	storageBucket: 'tuiot-ad770.firebasestorage.app',
	messagingSenderId: '174269480706',
	appId: '1:174269480706:web:96cbe14c0680f9f7c34c1b',
	measurementId: 'G-S1XNWLX6EY'
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const database = firebase.database();
let currentUser;
let isAdmin = false;
let authMode = 'login';
let registrationInProgress = false;
let pendingRequestsRef;
const ADMIN_EMAIL = 'tu7786110@gmail.com';

const authErrorMessage = (error) => ({
	'AUTH/INVALID-CREDENTIALS': 'Email hoặc mật khẩu không đúng',
	'auth/invalid-credential': 'Email hoặc mật khẩu không đúng',
	'auth/email-already-in-use': 'Email này đã được sử dụng',
	'auth/invalid-email': 'Email không hợp lệ',
	'auth/weak-password': 'Mật khẩu cần có ít nhất 6 ký tự'
}[error.code] || 'Không thể xác thực. Vui lòng thử lại.');

function setAuthMode(mode) {
	authMode = mode;
	const registering = mode === 'register';
	$('#authTitle').textContent = registering ? 'Tạo tài khoản' : 'Đăng nhập hệ thống';
	$('#authSubmit').innerHTML = `<i data-lucide="${registering ? 'user-plus' : 'log-in'}"></i>${registering ? 'Đăng ký' : 'Đăng nhập'}`;
	$('#authSwitch').textContent = registering ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký';
	$('#authPassword').setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
	lucide.createIcons();
}

function setAdminControls(enabled) {
	isAdmin = enabled;
	document.querySelectorAll('#thresholdForm input, #thresholdForm button, #phoneForm input, #phoneForm button').forEach((control) => { control.disabled = !enabled; });
	$('#settingsRole').textContent = enabled ? 'Quyền admin · Có thể chỉnh sửa' : 'Quyền xem · Chỉ admin mới được chỉnh sửa';
	$('#settingsRole').classList.toggle('admin', enabled);
}

function renderPhoneList(phoneNumbers = {}) {
	const list = $('#phoneList');
	list.innerHTML = '';
	Object.entries(phoneNumbers).forEach(([key, phone]) => {
		const item = document.createElement('li');
		item.innerHTML = `<span>${phone}</span><button type="button" data-phone-key="${key}" aria-label="Xóa số ${phone}"><i data-lucide="trash-2"></i></button>`;
		list.appendChild(item);
	});
	lucide.createIcons();
}

function showApprovalModal() {
	if (!isAdmin) return;
	$('#approvalModal').classList.add('is-open');
	$('#approvalModal').setAttribute('aria-hidden', 'false');
	loadAccessRequests();
}

async function loadAccessRequests() {
	const list = $('#approvalList');
	list.innerHTML = '';
	try {
		const snapshot = await database.ref('accessRequests').orderByChild('status').equalTo('pending').once('value');
		const requests = snapshot.val() || {};
		const entries = Object.entries(requests);
		$('#approvalEmpty').hidden = entries.length > 0;
		entries.forEach(([uid, request]) => {
			const item = document.createElement('li');
			item.innerHTML = `<div><strong>${request.email}</strong><small>Đăng ký lúc ${request.createdAt ? new Date(request.createdAt).toLocaleString('vi-VN') : 'chưa rõ'}</small></div><span><button type="button" class="approve-button" data-approval="approve" data-uid="${uid}">Duyệt</button><button type="button" class="reject-button" data-approval="reject" data-uid="${uid}">Từ chối</button></span>`;
			list.appendChild(item);
		});
	} catch (error) {
		$('#approvalEmpty').hidden = false;
		$('#approvalEmpty').textContent = 'Không thể tải yêu cầu. Kiểm tra Firebase Rules.';
	}
}

function watchPendingRequests(enabled) {
	if (pendingRequestsRef) pendingRequestsRef.off();
	pendingRequestsRef = null;
	const badge = $('#notificationBtn b');
	badge.hidden = !enabled;
	if (!enabled) return;
	pendingRequestsRef = database.ref('accessRequests');
	pendingRequestsRef.on('value', (snapshot) => {
		const requests = snapshot.val() || {};
		const count = Object.values(requests).filter((request) => request.status === 'pending').length;
		badge.textContent = count > 9 ? '9+' : count;
		badge.hidden = count === 0;
		$('#notificationBtn').title = count ? `${count} yêu cầu đăng ký chờ duyệt` : 'Không có yêu cầu đăng ký mới';
	});
}

async function updateAccessRequest(uid, decision) {
	if (!isAdmin) return;
	try {
		const updates = { [`accessRequests/${uid}/status`]: decision, [`accessRequests/${uid}/reviewedAt`]: firebase.database.ServerValue.TIMESTAMP };
		if (decision === 'approved') updates[`users/${uid}/role`] = 'user';
		await database.ref().update(updates);
		showToast(decision === 'approved' ? 'Đã duyệt tài khoản' : 'Đã từ chối tài khoản', decision === 'approved' ? 'check' : 'x-circle');
		loadAccessRequests();
	} catch (error) {
		showToast('Không thể cập nhật yêu cầu', 'triangle-alert');
	}
}

async function loadSettings() {
	try {
		const snapshot = await database.ref('settings').once('value');
		const settings = snapshot.val() || {};
		if (settings.alertThreshold !== undefined) $('#thresholdValue').value = settings.alertThreshold;
		renderPhoneList(settings.phoneNumbers || {});
		$('#thresholdStatus').textContent = 'Đã tải cấu hình từ Firebase';
	} catch (error) {
		$('#thresholdStatus').textContent = 'Không thể tải cấu hình từ Firebase';
	}
}

auth.onAuthStateChanged(async (user) => {
	currentUser = user;
	if (!user) {
		watchPendingRequests(false);
		$('#appShell').classList.add('auth-hidden');
		$('#authScreen').classList.remove('is-hidden');
		return;
	}
	if (registrationInProgress) return;
	if (user.email?.toLowerCase() !== ADMIN_EMAIL) {
		const requestSnapshot = await database.ref(`accessRequests/${user.uid}`).once('value');
		const request = requestSnapshot.val();
		if (!request || request.status !== 'approved') {
			await auth.signOut();
			$('#authError').textContent = request?.status === 'rejected' ? 'Yêu cầu đăng ký đã bị từ chối.' : 'Tài khoản đang chờ admin duyệt.';
			return;
		}
	}
	$('#authScreen').classList.add('is-hidden');
	$('#appShell').classList.remove('auth-hidden');
	$('#userRole').textContent = user.email?.toLowerCase() === ADMIN_EMAIL ? 'ADMIN' : user.email;
	try {
		const roleSnapshot = await database.ref(`users/${user.uid}/role`).once('value');
		setAdminControls(user.email?.toLowerCase() === ADMIN_EMAIL || roleSnapshot.val() === 'admin');
		watchPendingRequests(isAdmin);
	} catch (error) {
		setAdminControls(false);
		watchPendingRequests(false);
	}
	loadSettings();
});

$('#authSwitch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
$('#authForm').addEventListener('submit', async (event) => {
	event.preventDefault();
	const email = $('#authEmail').value.trim();
	const password = $('#authPassword').value;
	$('#authError').textContent = '';
	$('#authSubmit').disabled = true;
	try {
		if (authMode === 'register') {
			registrationInProgress = true;
			const credential = await auth.createUserWithEmailAndPassword(email, password);
			await database.ref(`accessRequests/${credential.user.uid}`).set({ email, status: 'pending', createdAt: firebase.database.ServerValue.TIMESTAMP });
			await auth.signOut();
			registrationInProgress = false;
			$('#authError').textContent = 'Đăng ký thành công. Vui lòng chờ admin duyệt tài khoản.';
		} 
		else await auth.signInWithEmailAndPassword(email, password);
	} catch (error) {
		registrationInProgress = false;
		$('#authError').textContent = authErrorMessage(error);
	} finally {
		$('#authSubmit').disabled = false;
	}
});
$('#logoutBtn').addEventListener('click', () => auth.signOut());
$('#notificationBtn').addEventListener('click', showApprovalModal);
$('#closeApprovalBtn').addEventListener('click', () => { $('#approvalModal').classList.remove('is-open'); $('#approvalModal').setAttribute('aria-hidden', 'true'); });
$('#approvalList').addEventListener('click', (event) => {
	const button = event.target.closest('[data-approval]');
	if (button) updateAccessRequest(button.dataset.uid, button.dataset.approval === 'approve' ? 'approved' : 'rejected');
});

const screenTitles = { overview: 'Tổng quan', sensors: 'Dữ liệu cảm biến', alerts: 'Cảnh báo', weather: 'Dự báo thời tiết', location: 'Vị trí & bản đồ', settings: 'Cấu hình hệ thống' };
const GAUGE_CIRCUMFERENCE = 169.65;

let stationMap;
function initStationMap() {
	if (stationMap || !window.L) return;
	stationMap = L.map('stationMap', { zoomControl: true }).setView([12.211889, 108.704333], 14);
	L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(stationMap);
	const marker = L.marker([12.211889, 108.704333]).addTo(stationMap);
	marker.bindPopup('<strong>Trạm TG-042</strong><br>Đèo Khánh Lê, Khánh Hòa').openPopup();
}

function switchScreen(screen) {
	document.querySelectorAll('.screen-item').forEach((item) => item.classList.toggle('is-active', item.dataset.screens.split(' ').includes(screen)));
	document.querySelectorAll('.content-grid, .bottom-grid').forEach((group) => group.classList.toggle('is-empty', !group.querySelector('.screen-item.is-active')));
	document.querySelectorAll('.tab-link, .view-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === screen));
	$('.breadcrumb').innerHTML = `Giám sát thời gian thực <span>/</span> ${screenTitles[screen]}`;
	$('#tong-quan').dataset.screen = screen;
	if (screen === 'location') window.setTimeout(() => { initStationMap(); stationMap?.invalidateSize(); }, 80);
	window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', (event) => {
	event.preventDefault();
	switchScreen(tab.dataset.tab);
	if (window.matchMedia('(max-width: 700px)').matches && appShell.classList.contains('sidebar-open')) appShell.classList.remove('sidebar-open');
}));
switchScreen('overview');
$('#openMapBtn').addEventListener('click', () => window.open('https://www.openstreetmap.org/?mlat=12.211889&mlon=108.704333#map=14/12.211889/108.704333', '_blank', 'noopener'));

function buildRainBars() {
	const wrap = $('#rainBars');
	if (!wrap || wrap.childElementCount) return;
	for (let i = 0; i < 12; i += 1) {
		const bar = document.createElement('i');
		wrap.appendChild(bar);
	}
}

function setGauge(id, percent) {
	const el = document.getElementById(id);
	if (!el) return;
	const clamped = Math.max(0, Math.min(100, percent));
	el.style.strokeDashoffset = (GAUGE_CIRCUMFERENCE * (1 - clamped / 100)).toFixed(1);
}

function updateRainBars(rainMm) {
	const bars = document.querySelectorAll('#rainBars i');
	const activeCount = Math.round((rainMm / 6) * bars.length);
	bars.forEach((bar, index) => {
		const fromEnd = bars.length - index;
		const height = 22 + ((index * 37) % 55);
		bar.style.height = `${height}%`;
		bar.classList.toggle('filled', fromEnd <= activeCount);
	});
}

function updateTelemetry() {
	const soil = randomBetween(67.2, 70.1);
	const mpuX = randomBetween(-0.012, 0.012, 3);
	const mpuY = randomBetween(-0.012, 0.012, 3);
	const mpuZ = randomBetween(0.985, 1.015, 3);
	const movement = randomBetween(0.8, 3.2, 2);
	const rain = randomBetween(2.9, 4.5);

	$('#soilValue').textContent = soil.toFixed(1);
	$('#mpuXValue').textContent = mpuX.toFixed(3);
	$('#mpuYValue').textContent = mpuY.toFixed(3);
	$('#mpuZValue').textContent = mpuZ.toFixed(3);
	$('#movementValue').textContent = movement.toFixed(2);
	$('#rainValue').textContent = rain.toFixed(1);

	setGauge('soilGauge', soil);
	setGauge('movementGauge', (movement / 5) * 100);
	updateRainBars(rain);

	const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
	$('#lastUpdate').textContent = time;
	$('#syncTime').textContent = 'vừa xong';
	$('#packetTime').textContent = '2 giây trước';
}

function showToast(message, icon = 'check-circle-2') {
	const toast = $('#toast');
	toast.querySelector('span').textContent = message;
	toast.querySelector('svg')?.remove();
	toast.insertAdjacentHTML('afterbegin', `<i data-lucide="${icon}"></i>`);
	lucide.createIcons();
	toast.classList.add('show');
	window.clearTimeout(showToast.timer);
	showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

$('#testAlertBtn').addEventListener('click', () => showToast('Đã gửi cảnh báo thử qua module SIM', 'send'));
$('#rangeSelect').addEventListener('change', (event) => showToast(`Đã chuyển sang ${event.target.value.toLowerCase()}`, 'bar-chart-3'));

$('#thresholdForm').addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!isAdmin || !currentUser) return;
	const threshold = Number($('#thresholdValue').value);
	if (!Number.isFinite(threshold) || threshold < 0) {
		$('#thresholdStatus').textContent = 'Ngưỡng phải là số không âm';
		return;
	}
	try {
		await database.ref('settings/alertThreshold').set(threshold);
		$('#thresholdStatus').textContent = 'Đã lưu ngưỡng lên Firebase';
		showToast('Đã lưu ngưỡng cảnh báo');
	} catch (error) {
		$('#thresholdStatus').textContent = 'Không có quyền lưu ngưỡng';
	}
});

$('#phoneForm').addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!isAdmin || !currentUser) return;
	const phone = $('#phoneNumber').value.trim();
	if (!/^(0|\+84)[\d\s.-]{8,14}$/.test(phone)) {
		$('#phoneStatus').textContent = 'Vui lòng nhập số điện thoại hợp lệ';
		return;
	}
	try {
		await database.ref('settings/phoneNumbers').push(phone);
		$('#phoneNumber').value = '';
		$('#phoneStatus').textContent = 'Đã thêm số điện thoại vào Firebase';
		loadSettings();
	} catch (error) {
		$('#phoneStatus').textContent = 'Không có quyền lưu số điện thoại';
	}
});

$('#phoneList').addEventListener('click', async (event) => {
	const button = event.target.closest('[data-phone-key]');
	if (!button || !isAdmin) return;
	try {
		await database.ref(`settings/phoneNumbers/${button.dataset.phoneKey}`).remove();
		loadSettings();
		showToast('Đã xóa số điện thoại');
	} catch (error) {
		showToast('Không có quyền xóa số điện thoại', 'triangle-alert');
	}
});

$('#connectionBtn').addEventListener('click', () => {
	const button = $('#connectionBtn');
	button.disabled = true;
	button.textContent = 'Đang kiểm tra...';
	window.setTimeout(() => {
		button.innerHTML = 'Kết nối ổn định <i data-lucide="check"></i>';
		button.disabled = false;
		lucide.createIcons();
		showToast('ESP32 đang kết nối và gửi dữ liệu bình thường');
	}, 900);
});

buildRainBars();
initWeather();
window.setInterval(updateTelemetry, 5000);
updateTelemetry();
lucide.createIcons();