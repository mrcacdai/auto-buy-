<?php
define("IN_SITE", true);
require_once __DIR__ . "/../libs/db.php";
require_once __DIR__ . "/../config.php";
require_once __DIR__ . "/../libs/lang.php";
require_once __DIR__ . "/../libs/helper.php";
require_once __DIR__ . "/../libs/database/users.php";

$CMSNT = new DB();
$user = new users();

$CMSNT->update("settings", ["value" => time()], " `name` = 'check_time_cron_bank' ");

foreach ($CMSNT->get_list(" SELECT * FROM `banks` WHERE `status` = 1 ") as $bank) {
    $short_name = strtoupper($bank["short_name"]);
    $result = null;
    
    // --- GỌI API THEO TỪNG CỔNG NGÂN HÀNG HỖ TRỢ ---
    if (in_array($short_name, ["ACB"])) {
        $result = curl_get("https://api.bytemart.io.vn/historyapiacb/" . $bank["token"]);
    } else if (in_array($short_name, ["VCB", "VIETCOMBANK"])) {
        $result = curl_get2("https://api.bytemart.io.vn/historyapivcb/" . $bank["token"]);
    } else if (in_array($short_name, ["MB", "MBBANK"])) {
        $result = curl_get("https://api.bytemart.io.vn/historyapimbbank/" . $bank["token"]);
    } else if (in_array($short_name, ["TPBANK", "TPB"])) {
        $result = curl_get("https://api.bytemart.io.vn/historyapitpb/" . $bank["token"]);
    }

    if (empty($result)) {
        continue;
    }

    $result = json_decode($result, true);
    
    // --- PHÂN TÁCH LOGIC XỬ LÝ THEO PHẢN HỒI JSON ---
    
    // 1. XỬ LÝ CHO VCB
    if (in_array($short_name, ["VCB", "VIETCOMBANK"])) {
        if (!isset($result["TranList"]) || !is_array($result["TranList"])) {
            continue;
        }
        foreach ($result["TranList"] as $data) {
            $type_code = isset($data["DorCCode"]) ? $data["DorCCode"] : $data["CD"];
            if ($type_code != "C" && $type_code != "+") {
                continue;
            }

            $tid = check_string($data["SeqNo"]);
            $description = check_string($data["Description"]);
            $amount = (int)str_replace(",", "", check_string($data["Amount"]));
            $type_log = "IN";

            process_deposit($CMSNT, $user, $bank, $tid, $description, $amount, $type_log);
        }
    }
    // 2. XỬ LÝ CHO TPBANK
    else if (in_array($short_name, ["TPBANK", "TPB"])) {
        if (!isset($result["TranList"]) || !is_array($result["TranList"])) {
            continue;
        }
        foreach ($result["TranList"] as $data) {
            $type_log = isset($data["type"]) ? strtoupper($data["type"]) : "IN";
            if ($type_log == "OUT") {
                continue;
            }

            $tid = check_string($data["transactionNumber"]);
            $description = check_string($data["massage"]);
            $amount = (int)$data["amount"];

            process_deposit($CMSNT, $user, $bank, $tid, $description, $amount, $type_log);
        }
    }
    // 3. XỬ LÝ CHO ACB
    else if ($short_name == "ACB") {
        if (!isset($result["TranList"]) || !is_array($result["TranList"])) {
            continue;
        }
        foreach ($result["TranList"] as $data) {
            $indicator = isset($data["creditDebitIndicator"]) ? $data["creditDebitIndicator"] : "";
            if ($indicator == "DBIT") {
                continue;
            }

            $tid = check_string($data["id"]);
            $description = str_replace(" ", ".", check_string($data["description"]));
            $amount = (int)str_replace(",", "", check_string($data["amount"]));
            $type_log = "IN";

            process_deposit($CMSNT, $user, $bank, $tid, $description, $amount, $type_log);
        }
    }
    // 4. XỬ LÝ CHO MBBANK
    else if (in_array($short_name, ["MB", "MBBANK"])) {
        if (!isset($result["TranList"]) || !is_array($result["TranList"])) {
            continue;
        }
        foreach ($result["TranList"] as $data) {
            $creditAmount = isset($data["creditAmount"]) ? (int)str_replace(",", "", $data["creditAmount"]) : 0;
            if ($creditAmount <= 0) {
                continue;
            }
            $tid = check_string($data["tranId"]);
            $description = str_replace(" ", ".", check_string($data["description"]));
            $amount = $creditAmount;
            $type_log = "IN";
            
            process_deposit($CMSNT, $user, $bank, $tid, $description, $amount, $type_log);
        }
    }
}

// --- HÀM XỬ LÝ CỘNG TIỀN TẬP TRUNG TỪ RAW DATA ---
function process_deposit($CMSNT, $user, $bank, $tid, $description, $amount, $type_log) {
    $user_id = parse_order_id($description, $CMSNT->site("prefix_autobank"));

    // Kiểm tra hạn mức nạp tiền
    if ($amount < $CMSNT->site("bank_min") || $CMSNT->site("bank_max") < $amount) {
        return;
    }

    // Kiểm tra user có tồn tại và đơn đã xử lý chưa
    $getUser = $CMSNT->get_row(" SELECT * FROM `users` WHERE `id` = '" . $user_id . "' ");
    if ($getUser) {
        $check_processed = $CMSNT->num_rows(" SELECT * FROM `payment_bank` WHERE `tid` = '" . $tid . "' AND `description` = '" . $description . "' ");
        
        if ($check_processed == 0) {
            $received = checkPromotion($amount);
            
            // Ghi nhận vào bảng hóa đơn
            $insertSv2 = $CMSNT->insert("payment_bank", [
                "tid" => $tid, 
                "method" => $bank["short_name"], 
                "user_id" => $getUser["id"], 
                "description" => $description, 
                "amount" => $amount, 
                "received" => $received, 
                "create_gettime" => gettime(), 
                "create_time" => time()
            ]);

            if ($insertSv2) {
                // Cộng tiền tài khoản
                $isCong = $user->AddCredits(
                    $getUser["id"], 
                    $received, 
                    "Nạp tiền tự động qua " . $bank["short_name"] . " (#" . $tid . " - " . $description . " - " . $amount . ")", 
                    "TOPUP_" . $bank["accountNumber"] . "_" . $tid
                );

                if ($isCong) {
                    // Trả thưởng hoa hồng CTV/Affiliate
                    if ($CMSNT->site("affiliate_status") == 1 && $getUser["ref_id"] != 0) {
                        $ck = $CMSNT->site("affiliate_ck");
                        if (getRowRealtime("users", $getUser["ref_id"], "ref_ck") != 0) {
                            $ck = getRowRealtime("users", $getUser["ref_id"], "ref_ck");
                        }
                        $price = $received * $ck / 100;
                        $user->AddCommission($getUser["ref_id"], $getUser["id"], $price, __("Hoa hồng thành viên " . $getUser["username"]));
                    }

                    // Tự động xử lý cấn trừ ví nợ âm
                    debit_processing($getUser["id"]);
                    
                    $CMSNT->insert("deposit_log", [
                        "user_id" => $getUser["id"], 
                        "method" => $bank["short_name"], 
                        "amount" => $amount, 
                        "received" => $received, 
                        "create_time" => time(), 
                        "is_virtual" => 0
                    ]);

                    // Đẩy thông báo Telegram
                    $my_text = $CMSNT->site("noti_recharge");
                    $my_text = str_replace("{domain}", $_SERVER["SERVER_NAME"], $my_text);
                    $my_text = str_replace("{username}", $getUser["username"], $my_text);
                    $my_text = str_replace("{method}", $bank["short_name"], $my_text);
                    $my_text = str_replace("{amount}", format_currency($amount), $my_text);
                    $my_text = str_replace("{price}", format_currency($received), $my_text);
                    $my_text = str_replace("{time}", gettime(), $my_text);
                    sendMessAdmin($my_text);

                    echo "[ - ] Duyệt thành công hóa đơn: " . $tid . PHP_EOL;
                }
            }
        }
    }

    // Ghi Raw Log hệ thống
    $check_raw_log = $CMSNT->get_row(" SELECT COUNT(id) FROM `log_bank_auto` WHERE `tid` = '" . $tid . "' AND `description` = '" . $description . "' AND `method` = '" . $bank["short_name"] . "' ");
    if ($check_raw_log["COUNT(id)"] == 0) {
        $CMSNT->insert("log_bank_auto", [
            "tid" => $tid, 
            "method" => $bank["short_name"], 
            "description" => $description, 
            "type" => $type_log, 
            "amount" => $amount, 
            "create_gettime" => gettime()
        ]);
    }
}

curl_get2(base_url("cron/cron.php"));
?>