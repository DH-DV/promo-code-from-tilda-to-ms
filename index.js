const http = require('http');

const PORT = process.env['PORT'] || 3000;
const WEBHOOK_TOKEN = process.env['WEBHOOK_TOKEN'];
const MOYSKLAD_API_TOKEN = process.env['MOYSKLAD_API_TOKEN'];
const PROMO_CODE_ATTRIBUTE_ID = process.env['PROMO_CODE_ATTRIBUTE_ID'];
const DELAY_MS = 60 * 1000; // 1 минута между попытками
const MAX_ATTEMPTS = 3; // Максимальное количество попыток

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Обработка заказа в МойСклад с повторными попытками
 */
async function processOrderInMoySklad(orderId, promocode) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`Ожидание 1 мин перед попыткой ${attempt}/${MAX_ATTEMPTS} для заказа ${orderId}...`);
    await sleep(DELAY_MS);

    try {
      const url = `https://api.moysklad.ru/api/remap/1.2/entity/customerorder?filter=code=${orderId};externalCode=${orderId}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${MOYSKLAD_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error(`[Попытка ${attempt}] Ошибка запроса к API МойСклад: ${response.status} ${response.statusText}`);
        continue;
      }

      const data = await response.json();

      if (!data.rows || data.rows.length === 0) {
        if (attempt === MAX_ATTEMPTS) {
          console.error('ошибка, заказ в МС не найден');
        } else {
          console.log(`[Попытка ${attempt}/${MAX_ATTEMPTS}] Заказ ${orderId} пока не найден в МС, повтор через 1 минуту...`);
        }
        continue;
      }

      const order = data.rows[0];
      const attributes = Array.isArray(order.attributes) ? [...order.attributes] : [];

      const existingAttrIndex = attributes.findIndex(attr => {
        if (attr.id && attr.id === PROMO_CODE_ATTRIBUTE_ID) {
          return true;
        }
        if (attr.meta && attr.meta.href && attr.meta.href.endsWith(`/${PROMO_CODE_ATTRIBUTE_ID}`)) {
          return true;
        }
        return false;
      });

      if (existingAttrIndex !== -1) {
        console.error(`промокод для заказа ${order.name} уже заполнен.`);
        return;
      }

      attributes.push({
        meta: {
          href: `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/attributes/${PROMO_CODE_ATTRIBUTE_ID}`,
          type: 'attributemetadata',
          mediaType: 'application/json'
        },
        value: String(promocode)
      });

      const updateResponse = await fetch(order.meta.href, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${MOYSKLAD_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          meta: order.meta,
          attributes: attributes
        })
      });

      if (!updateResponse.ok) {
        const errText = await updateResponse.text();
        console.error(`Ошибка при обновлении заказа ${order.name} в МойСклад: ${updateResponse.status} - ${errText}`);
        return;
      }

      console.log(`Промокод "${promocode}" успешно добавлен к заказу ${order.name}`);
      return; // Успешно обновлено, выходим из цикла
    } catch (error) {
      console.error(`[Попытка ${attempt}/${MAX_ATTEMPTS}] Ошибка при обработке заказа ${orderId}:`, error);
    }
  }
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  console.log(`[${new Date().toISOString()}] Входящий запрос: ${req.method} ${url.pathname}`);

  // Healthcheck эндпоинты для хостинга и проверки доступности в браузере
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/webhook')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'promo-code-webhook',
      endpoint: '/webhook',
      method_expected: 'POST',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Обработка вебхука (поддерживаем /webhook и корень /)
  if (req.method === 'POST' && (pathname === '/webhook' || pathname === '/')) {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      console.log(`[${new Date().toISOString()}] Получено тело запроса (длина: ${body.length} байт)`);

      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Ошибка парсинга JSON: ${e.message}. Тело: ${body.slice(0, 300)}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // Полное логирование входящего JSON
      console.log(`[${new Date().toISOString()}] Входящий JSON запроса:\n${JSON.stringify(payload, null, 2)}`);

      // Проверка авторизации по токену в теле запроса (в корне или внутри body)
      const incomingToken = payload.token || (payload.body && payload.body.token);
      if (!incomingToken || incomingToken !== WEBHOOK_TOKEN) {
        console.warn(`[${new Date().toISOString()}] Ошибка 401 Unauthorized. Ожидался WEBHOOK_TOKEN, получен: "${incomingToken ? '***' : 'отсутствует'}"`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // Данные могут приходить как в корне payload, так и внутри payload.body
      const data = (payload.body && typeof payload.body === 'object') ? payload.body : payload;
      const formname = data.formname;
      const payment = data.payment;
      const promocode = payment && payment.promocode;
      const orderid = payment && payment.orderid;

      console.log(`[${new Date().toISOString()}] Данные хука: formname="${formname}", orderid="${orderid}", promocode="${promocode}"`);
      // Проверяем условия для обработки заказа
      if (
        formname === 'Cart' &&
        promocode !== null &&
        promocode !== undefined &&
        String(promocode).trim() !== '' &&
        orderid
      ) {
        // Сразу отправляем 200 OK
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', message: 'Order accepted for processing' }));

        console.log(`[${new Date().toISOString()}] Заказ ${orderid} принят в обработку. Запуск цикла поиска в МС (до 3 попыток с интервалом 1 мин)...`);

        // Фоновый запуск обработки с повторными попытками
        processOrderInMoySklad(orderid, promocode);
        return;
      }

      // Если условия не выполнены, возвращаем 200 OK без дальнейшей обработки
      console.log(`[${new Date().toISOString()}] Запрос пропущен (не Cart или нет промокода): formname="${formname}", promocode="${promocode}"`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK', message: 'Skipped: not Cart or no promocode' }));
    });
    return;
  }

  // Неподдерживаемый маршрут или метод
  console.warn(`[${new Date().toISOString()}] Маршрут не найден: ${req.method} ${pathname}`);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});
server.listen(PORT, () => {
  console.log(`Сервер вебхука запущен на порту ${PORT}`);
});