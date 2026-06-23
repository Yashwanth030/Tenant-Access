import React from "react";
import { useNavigate } from "react-router-dom";
import "./css/home.css";

function Home() {
  const navigate = useNavigate();

  return (
    <div className="landing-container">
      <div className="landing-wrapper">
        <div className="landing-card">
          
          <img
            src="/Incture_Technologies_Logo.png"
            alt="Incture"
            className="landing-logo"
          />
         
          {/* <img
            src="https://th.bing.com/th/id/ODF.t8h2yfCd2ea66jR9A0bEfQ?w=32&h=32&qlt=90&pcl=fffffc&r=0&o=6&pid=1.2"
            alt="Icon"
            className="landing-logo"
          /> */}
          <h2 className="landing-title">
            Welcome to
          </h2>
          <h2 className="landing-title">
            Integration suite
          </h2>
          <h2 className="landing-title">
            Monitoring Overview
          </h2>
          <button
            className="login-btn"
            onClick={() => navigate("/login")}
          >
            Login
          </button>
        </div>
      </div>
    </div>
  );
}

export default Home;
