import { parseBLTextToJson } from './blParser.js';

const rawText = `
MODEL NO:
GH-TWSUA-BK
L000/2604
C/NO:
MADE IN CHINA
EMCU6556720/20'GP/EMCEFZ5425/1PALLET /205KGS/2.200CBM
BLUETOOTH HEADSET
HS CODE:8517629400
PORT OF DISCHARGE PLACE OF DELIVERY
VESSEL & VOY NO. PORT OF LOADING
PLACE OF RECEIPT
EXPORT REFERENCES
B/L NO.
NOTIFY PARTY
CONSIGNEE
SHIPPER
GREEN HOUSE CO.,LTD
5F UNOSAWA TOKYU BLD. 1-19-15 EBISU, SHIBUYA-KU,
TOKYO 150-
0013, JAPAN
SAME AS CONSIGNEE
205KGS
EVER WORLD 1734-006N
YOKOHAMA, JAPAN
ZHEJIANG HENGDIAN INNUOVO IMP.&EXP. CO.,LTD
15/F,T1,HENGDIAN CENTER, NO.136 FUCHUN ROAD,
SHANGCHENG
DISTRICT, HANGZHOU, ZHEJIANG CHINA
YOKOHAMA, JAPAN
2.200CBM
SHEKOU, CHINA
SHIPPED ON BOARD:
SHEKOU, CHINA
1PALLET
JZHS26000799
HS26040204
TOTAL: ONE (1) 20'GP CONTAINER ONLY
POINT AND COUNTRY OF ORIGIN
ALSO NOTIFY
FOR DELIVERY, PLEASE CONTACT
PRECARRIAGE BY
EXCESS LIMIT DECLARATION AS PER CLAUSE 16
MARKS AND NUMBER NO. OF PKGS DESCRIPTION OF PACKAGES AND GOODS
(PARTICULARS FURNISHED BY SHIPPER)
GROSS WEIGHT MEASUREMENT
The above particulars of the goods are according to the declaration of the shipper, and are unknown to the Carrier.
FREIGHT RATES. CHARGES. WEIGHTS AND/OR MEASUREMENTS
SUBJECT TO CORRECTION PREPAID COLLECT
The Carrier received the above goods in apparent good order and
condition, unless otherwise specified, for carriage to the place as
agreed above subject to the terms and condition of the bill lading
including those on the back page. One original of this Bill of Lading
must be surrendered duly endorsed in exchange for the goods.
IN WITNESS WHEREOF the Carrier or its agent has signed three (3)
Bills of Lading, all of this tenor and date, one of which being
accomplished, the other stand void.
PLACE OF ISSUE ORIGINAL B/L (S) DATE OF ISSUE
ZHONGSHAN, CHINA ZERO(0)
The contract evidenced by this Bill of Lading is governed by the laws of The
People's Republic of China. Any claim or dispute must be determined
exclusively in the courts in The People's Republic of China and no other court
By
STAMP/SIGNATURE OF THE CARRIER OR ITS AGENT
BUSINESS LABO CO.,LTD.
KABUTOCHO NO.6 HAYAMA BLDG. 4F, 17-2 NIHONBASHI
KABUTOCHO CHUO-KU TOKYO 103-0026 JAPAN
TEL:+81-3-6555-4496 FAX:+81-3-4496-4103
EMAIL:OPERATION@BIZLABO-TOKYO.CO.JP
(PART OF 1X20'GP) (CY-CY)
2026/04/11
2026/04/11
FREIGHT COLLECT
JANCO INTERNATIONAL FREIGHT (CHINA) LTD.
as the carrier BILL OF LADING
`;

const result = parseBLTextToJson(rawText);
console.log(JSON.stringify(result, null, 2));