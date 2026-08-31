/**
 * Default price master - 2026年8月時点の参考値
 */
export function getDefaultPriceMaster() {
  return {
    version: 1,
    updatedAt: '2026-08-30',
    services: [
      {
        id: 'dmm-ev-on',
        name: 'DMM EV ON',
        aliases: ['DMM EV ON', 'DMM', 'DMM.e.V', 'DMM EV'],
        enabled: true,
        monthlyFee: 0,
        visitorAvailable: true,
        plans: [
          { type: 'DC', powerKw: 50, price: 27, unit: 'JPY/min', note: '50kW急速' },
          { type: 'DC', powerKw: 90, price: 42, unit: 'JPY/min', note: '90kW急速' },
          { type: 'AC', powerKw: 6, price: 3.3, unit: 'JPY/min', note: '普通6kW（33円/10分）' }
        ]
      },
      {
        id: 'eneos-charge-plus',
        name: 'ENEOS Charge Plus',
        aliases: ['ENEOS Charge Plus', 'ENEOS', 'ENEOSチャージプラス', 'エネオス'],
        enabled: true,
        monthlyFee: 0,
        visitorAvailable: true,
        plans: [
          { type: 'DC', powerKw: null, price: 46.2, unit: 'JPY/min', note: '会員・シンプルプラン' },
          { type: 'DC', powerKw: null, price: 49.5, unit: 'JPY/min', note: '非会員' },
          { type: 'AC', powerKw: 6, price: 0.66, unit: 'JPY/min', note: '普通6.6円/分' }
        ]
      },
      {
        id: 'honda-charge',
        name: 'Honda Charge',
        aliases: ['Honda Charge', 'ホンダチャージ', 'Honda', 'プラゴ'],
        enabled: true,
        monthlyFee: 0,
        visitorAvailable: true,
        plans: [
          { type: 'DC', powerKw: 50, price: 55, unit: 'JPY/min', note: '50kW' },
          { type: 'DC', powerKw: 90, price: 77, unit: 'JPY/min', note: '90kW' }
        ]
      },
      {
        id: 'powerx',
        name: 'PowerX',
        aliases: ['PowerX', 'パワーエックス', 'POWER X'],
        enabled: true,
        monthlyFee: 0,
        visitorAvailable: true,
        plans: [
          { type: 'DC', powerKw: null, price: 65, unit: 'JPY/kWh', note: '一般利用' },
          { type: 'DC', powerKw: null, price: 45, unit: 'JPY/kWh', note: 'PowerX First会員' }
        ]
      },
      {
        id: 'emp',
        name: 'e-Mobility Power',
        aliases: [
          'e-Mobility Power', 'eMP', 'e-Mobility', 'eモビリティパワー',
          'eMP 急速・普通併用', 'eMP 急速充電器用', 'eMP 急速充電',
          'e-Mobility Power 急速', 'e-Mobility Power 急速・普通併用'
        ],
        enabled: true,
        monthlyFee: 0,
        visitorAvailable: true,
        plans: [
          { type: 'DC', powerKw: 50, price: 55, unit: 'JPY/min', location: 'general', note: '一般道・50kW以下' },
          { type: 'DC', powerKw: 75, price: 77, unit: 'JPY/min', location: 'general', note: '一般道・50-100kW' },
          { type: 'DC', powerKw: 150, price: 99, unit: 'JPY/min', location: 'general', note: '一般道・100kW超' },
          { type: 'DC', powerKw: 50, price: 77, unit: 'JPY/min', location: 'highway', note: '高速・50kW以下' },
          { type: 'DC', powerKw: 75, price: 99, unit: 'JPY/min', location: 'highway', note: '高速・50-100kW' },
          { type: 'DC', powerKw: 150, price: 121, unit: 'JPY/min', location: 'highway', note: '高速・100kW超' },
          { type: 'DC', powerKw: null, price: 110, unit: 'JPY/kWh', location: 'general', note: 'kWh課金・一般道' },
          { type: 'DC', powerKw: null, price: 143, unit: 'JPY/kWh', location: 'highway', note: 'kWh課金・高速' }
        ]
      },
      {
        id: 'ev-enechange',
        name: 'EV充電エネチェンジ',
        aliases: ['EV充電エネチェンジ', 'エネチェンジ', 'enechange', 'EVエネチェンジ'],
        enabled: true,
        monthlyFee: 0,
        visitorAvailable: true,
        plans: [
          { type: 'DC', powerKw: null, price: 60, unit: 'JPY/min', note: '参考値・要確認' }
        ]
      },
      {
        id: 'terra-charge',
        name: 'Terra Charge',
        aliases: ['Terra Charge', 'テラチャージ', 'TERRA CHARGE'],
        enabled: true,
        monthlyFee: 0,
        visitorAvailable: true,
        plans: [
          { type: 'DC', powerKw: null, price: 55, unit: 'JPY/min', note: '参考値・要確認' }
        ]
      },
      {
        id: 'toyota-phv',
        name: 'トヨタ PHV充電サポート',
        aliases: ['トヨタ PHV充電サポート', 'トヨタPHV', 'TEEMO'],
        enabled: false,
        monthlyFee: 0,
        visitorAvailable: false,
        requiresMembership: true,
        plans: []
      },
      {
        id: 'mitsubishi-ev',
        name: '三菱自動車 電動車両サポート',
        aliases: ['三菱自動車 電動車両サポート', '三菱電動車両サポート', '三菱'],
        enabled: false,
        monthlyFee: 0,
        visitorAvailable: false,
        requiresMembership: true,
        plans: []
      },
      {
        id: 'nissan-zesp',
        name: '日産 ZESP',
        aliases: ['ZESP3', 'ZESP2', 'ZESP', '日産 ZESP3', '日産 ZESP2/ZESP3', '日産 ZESP'],
        enabled: false,
        monthlyFee: 0,
        visitorAvailable: false,
        requiresMembership: true,
        plans: [
          { type: 'DC', powerKw: null, price: 99, unit: 'JPY/min', note: 'シンプルプラン' }
        ]
      },
      {
        id: 'bmw-chargenow',
        name: 'BMW ChargeNow',
        aliases: ['BMW ChargeNow', 'BMW', 'ChargeNow'],
        enabled: false,
        monthlyFee: 0,
        visitorAvailable: false,
        requiresMembership: true,
        plans: []
      }
    ]
  };
}

export function getDefaultServiceEnabled() {
  const master = getDefaultPriceMaster();
  const map = {};
  for (const svc of master.services) {
    map[svc.id] = svc.enabled;
  }
  return map;
}
